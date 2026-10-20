import type { MemoSpace } from "./types.ts";

export const visibilityOptions = [
  { value: "PRIVATE", label: "Private", short: "Private", hint: "Only you" },
  { value: "PROTECTED", label: "Signed-in users", short: "Signed-in", hint: "Anyone with an account" },
  { value: "PUBLIC", label: "Public", short: "Public", hint: "Anyone with the link" },
  { value: "SPACE", label: "Space members", short: "Space", hint: "People in one space" },
];

export function visibilityShort(value: string, space: string, spaces: MemoSpace[]): string {
  const spaceTitle = space ? spaces.find((item) => item.name === space)?.title : undefined;
  if (value === "SPACE") {
    return spaceTitle || "Space";
  }
  const short = visibilityOptions.find((item) => item.value === value)?.short ?? "Private";
  return spaceTitle ? `${short} | ${spaceTitle}` : short;
}
