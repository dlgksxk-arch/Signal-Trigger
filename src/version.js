export const appVersion = {
  major: 1,
  minor: 0,
  patch: 28
};

export function getVersionLabel() {
  return `V${appVersion.major}.${appVersion.minor}.${appVersion.patch}`;
}
