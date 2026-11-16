import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// Only inspect candidate-added sandbox tests. These are all the files in this
// directory in the immutable base; none of their contents are read here.
const preserved = new Set([
  'accept-selfcheck.test.ts', 'assets.test.ts', 'fake-pi.ts',
  'launcher.test.ts', 'native-scope.ts', 'receipt-exit.ts', 'runner.test.ts',
]);
const directory = resolve(process.cwd(), 'test/host/sandbox');
const added = [];
function discover(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (preserved.has(relative)) continue;
    if (entry.isDirectory()) discover(join(dir, entry.name), relative + '/');
    else if (entry.isFile() && /\.test\.(?:ts|js|mjs)$/.test(entry.name)) added.push(join(dir, entry.name));
  }
}
discover(directory);

function inspect(filename) {
  const source = readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declarations = [];
  const bindings = new Map();
  function visit(node) {
    if (ts.isCallExpression(node) && ['it', 'test'].includes(node.expression.getText(tree))) {
      const callback = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (callback) declarations.push(callback);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) bindings.set(node.name.text, node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  function calls(node) {
    const result = [];
    function walk(current) {
      if (ts.isCallExpression(current)) result.push(current);
      ts.forEachChild(current, walk);
    }
    walk(node);
    return result;
  }
  function closure(node) {
    const seen = new Set();
    const nodes = [node];
    function walk(current) {
      if (ts.isIdentifier(current) && bindings.has(current.text) && !seen.has(current.text)) {
        seen.add(current.text);
        const dependency = bindings.get(current.text);
        nodes.push(dependency);
        walk(dependency);
      }
      ts.forEachChild(current, walk);
    }
    walk(node);
    return nodes;
  }
  return declarations.map((node) => {
    const nodes = closure(node);
    const allCalls = nodes.flatMap(calls);
    return {
      body: nodes.map((part) => part.getText(tree)).join('\n'),
      launches: allCalls.filter((call) => /(?:spawn|execFile)(?:Sync)?$/.test(call.expression.getText(tree))).length,
      assertions: allCalls.filter((call) => /^assert(?:\.|$)/.test(call.expression.getText(tree))).map((call) => call.getText(tree)),
    };
  });
}
const integrations = added.flatMap(inspect).filter(({ body, launches }) =>
  /NODE_OPTIONS/.test(body) && launches > 0
  && /(?:pi\.ts|wrapper)/i.test(body)
  && /(?:writeFile|appendFile)(?:Sync)?\s*\(/.test(body));

test('an added regression exercises the wrapper entry point with a fake Pi executable', () => {
  assert.ok(integrations.length > 0,
    'Add an integration regression beside the preserved sandbox tests, with a planted loader, fake executable, and actual wrapper subprocess');
});

test('the integration includes a working require-loader control and successful child assertions', () => {
  assert.ok(integrations.some(({ body, launches, assertions }) =>
    /--require/.test(body)
    && /process\.execPath/.test(body)
    && /(?:mkdtemp|tmpdir)/.test(body)
    && launches >= 2
    && assertions.length >= 3),
  'The added integration must include an unfiltered positive control and assertions for successful child execution and loader exclusion');
});

test('the added integration separates wrapper and child observations and cleans fixtures', () => {
  assert.ok(integrations.some(({ body, assertions }) => {
    const distinguishesProcesses = /(?:process\.pid|process\.argv|process\.ppid)/.test(body)
      || ((body.match(/(?:join|resolve)\s*\(/g) ?? []).length >= 3);
    const assertsAbsence = assertions.some((call) => /(?:false|\b0\b|deepEqual\([^]*?\[\]|!|doesNotMatch|undefined)/.test(call));
    return distinguishesProcesses && assertsAbsence
      && /finally\s*\{/.test(body)
      && /(?:rm|rmdir)(?:Sync)?\s*\(/.test(body);
  }), 'The regression needs separate wrapper/child evidence, a loader-absence assertion sensitive to inheritance, and fixture cleanup');
});
// factory-holdout-b5d541d600dc5418d5c79656d5176627df5ba3abacb503ce061d2ee630fa47be
