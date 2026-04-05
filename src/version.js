export const appVersion = {
  major: 1,
  minor: 0,
  patch: 1
};

export function getVersionLabel() {
  return `V${appVersion.major}.${appVersion.minor}.${appVersion.patch}`;
}
