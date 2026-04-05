export const appVersion = {
  major: 1,
  minor: 0,
  patch: 26
};

export function getVersionLabel() {
  return `V${appVersion.major}.${appVersion.minor}.${appVersion.patch}`;
}
