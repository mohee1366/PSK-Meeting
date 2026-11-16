// EAS project ID is injected by the authorized build environment.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...(config.extra || {}),
    eas: {
      ...((config.extra && config.extra.eas) || {}),
      ...(process.env.EXPO_PROJECT_ID ? { projectId: process.env.EXPO_PROJECT_ID } : {})
    }
  }
});
