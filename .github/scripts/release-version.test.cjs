/** Verify release detection without calling GitHub or publishing a package. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const detectReleaseVersion = require('./release-version.cjs');

/** Provide a fake push and record the workflow outputs. */
function fixture(previousVersion, before = 'a'.repeat(40)) {
  const outputs = {};
  const requests = [];
  return {
    outputs,
    requests,
    api: {
      context: { repo: { owner: 'example', repo: 'extension' }, payload: { before } },
      core: {
        setOutput: (name, value) => {
          outputs[name] = value;
        },
      },
      github: {
        rest: {
          repos: {
            getContent: async (request) => {
              requests.push(request);
              return {
                data: {
                  content: Buffer.from(JSON.stringify({ version: previousVersion })).toString(
                    'base64',
                  ),
                },
              };
            },
          },
        },
      },
    },
  };
}

const manifest = { name: 'cpp-test-explorer', version: '0.1.2' };

test('a changed version publishes the final push version', async () => {
  const { api, outputs, requests } = fixture('0.1.0');
  await detectReleaseVersion(api, manifest);
  assert.deepEqual(outputs, {
    changed: true,
    version: '0.1.2',
    vsix: 'cpp-test-explorer-0.1.2.vsix',
  });
  assert.equal(requests[0].ref, api.context.payload.before);
  assert.equal(requests[0].path, 'package.json');
});

test('an unchanged version does not publish', async () => {
  const { api, outputs } = fixture('0.1.2');
  await detectReleaseVersion(api, manifest);
  assert.equal(outputs.changed, false);
});

test('the first push has no prior version to fetch', async () => {
  const { api, outputs, requests } = fixture(undefined, '0'.repeat(40));
  await detectReleaseVersion(api, manifest);
  assert.equal(outputs.changed, true);
  assert.deepEqual(requests, []);
});

test('a failed comparison does not produce publish outputs', async () => {
  const { api, outputs } = fixture('0.1.1');
  api.github.rest.repos.getContent = async () => {
    throw new Error('Unavailable');
  };
  await assert.rejects(detectReleaseVersion(api, manifest), /Unavailable/);
  assert.deepEqual(outputs, {});
});

test('invalid versions cannot become workflow outputs', async () => {
  const { api, outputs } = fixture('0.1.1');
  await assert.rejects(
    detectReleaseVersion(api, { ...manifest, version: 'invalid\nversion' }),
    /major.minor.patch/,
  );
  assert.deepEqual(outputs, {});
});
