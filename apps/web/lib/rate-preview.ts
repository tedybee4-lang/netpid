// MikroTik rate pairs are "<upload>/<download>" — upload FIRST. Showing the
// exact string that will reach the router is the difference between an ISP
// that trusts the speed field and one that files a support ticket.
// Shared by the new-package and edit-package screens so they can never preview
// a different rate string for the same input.
export function previewRate(uploadMbps: number, downloadMbps: number): string {
  const up = Math.round(uploadMbps * 1000);
  const down = Math.round(downloadMbps * 1000);
  if (up <= 0 && down <= 0) return "no cap (uncapped)";
  const rx = up > 0 ? up : down;
  const tx = down > 0 ? down : up;
  return `${rx}k/${tx}k`;
}

export const PRESETS: { name: string; down: number; up: number }[] = [
  { name: "Home 5", down: 5, up: 1 },
  { name: "Home 10", down: 10, up: 2 },
  { name: "Home 20", down: 20, up: 5 },
  { name: "Business 50", down: 50, up: 25 },
  { name: "Uncapped", down: 0, up: 0 },
];
