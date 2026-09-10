/** Detect package version changes across the complete push being validated. */
module.exports = async function detectReleaseVersion({ github, context, core }, manifest) {
  let previousVersion;
  const before = context.payload.before;
  if (!before || !/^[0-9a-f]{40}$/.test(before)) {
    throw new Error('A push commit is required to compare package versions.');
  }

  if (!/^0+$/.test(before)) {
    const { data } = await github.rest.repos.getContent({
      ...context.repo,
      path: 'package.json',
      ref: before,
    });
    const previousManifest = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    previousVersion = previousManifest.version;
  }

  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('The extension version must have the form major.minor.patch.');
  }
  core.setOutput('changed', manifest.version !== previousVersion);
  core.setOutput('version', manifest.version);
  core.setOutput('vsix', `${manifest.name}-${manifest.version}.vsix`);
};
