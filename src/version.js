export const appVersion = {
  major: 0,
  minor: 0,
  patch: 5
};

export function getVersionLabel() {
  return `V${appVersion.major}.${appVersion.minor}.${appVersion.patch}`;
}
