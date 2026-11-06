export function uniqueFiles(files: File[]): File[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  return [...data.files];
}
