import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { PI_AGENT_DIR, FORCED_PI_FLAGS, piChildEnv, wrapPiArgv } from '../../../../host/bundle/assets/pi.ts';

test('the unchanged production path continues to filter the child environment', () => {
  const input = {
    PATH: '/usr/bin:/bin',
    HOME: '/workspace',
    FACTORY_PI_TOOLS: 'read',
    NODE_OPTIONS: '--require /tmp/planted.cjs',
    NODE_PATH: '/tmp/modules',
    NODE_REPL_EXTERNAL_MODULE: '/tmp/planted.cjs',
    NODE_PRESERVE_SYMLINKS: '1',
    NODE_PRESERVE_SYMLINKS_MAIN: '1',
    PI_CODING_AGENT_DIR: '/tmp/untrusted-agent',
  };
  const snapshot = { ...input };
  assert.deepEqual(piChildEnv(input), {
    PATH: '/usr/bin:/bin',
    HOME: '/workspace',
    FACTORY_PI_TOOLS: 'read',
    PI_CODING_AGENT_DIR: PI_AGENT_DIR,
  });
  assert.deepEqual(input, snapshot);
  const wrapped = wrapPiArgv([], ['read']);
  assert.equal(wrapped.ok, true);
  if (wrapped.ok) assert.deepEqual(wrapped.argv.slice(0, FORCED_PI_FLAGS.length), [...FORCED_PI_FLAGS]);
});

test('the production entry point retains its real filtered spawn and lifecycle handling', () => {
  const source = readFileSync(resolve(process.cwd(), 'host/bundle/assets/pi.ts'), 'utf8');
  const compact = source.replace(/\s+/g, '');
  assert.ok(compact.includes('spawn(process.execPath,[PI_CLI,...wrapped.argv],{stdio:"inherit",env:piChildEnv(process.env),})'));
  assert.ok(compact.includes('if(import.meta.main)main();'));
  assert.ok(compact.includes('process.env.FACTORY_PI_TOOLS===undefined||!wrapped.ok'));
  assert.ok(compact.includes('process.exitCode=2;'));
  assert.ok(compact.includes('["SIGTERM","SIGINT","SIGHUP"]'));
  assert.ok(compact.includes('child.kill(signal)'));
  assert.ok(compact.includes('process.exitCode=code??(signal===null?1:128)'));
});
// factory-holdout-b5d541d600dc5418d5c79656d5176627df5ba3abacb503ce061d2ee630fa47be
