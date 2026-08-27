export function parseCommandOptions(argv, { booleanFlags = [] } = {}) {
  const [command, ...rest] = argv;
  const options = {};
  const booleanFlagSet = new Set(booleanFlags);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const name = flag?.startsWith('--') ? flag.slice(2) : null;
    if (name && booleanFlagSet.has(name)) {
      options[name] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`应使用 --name value 参数，实际为 ${flag ?? '空值'}`);
    }
    options[name] = value;
    index += 1;
  }
  return { command, options };
}
