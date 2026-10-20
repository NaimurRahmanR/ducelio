export function isApprovedDbPush(args) {
  const flags = args.slice(2);
  return (
    args.length === 5 &&
    args[0] === "db" &&
    args[1] === "push" &&
    new Set(flags).size === 3 &&
    flags.includes("--linked") &&
    flags.includes("--skip-vault") &&
    flags.includes("--dry-run") !== flags.includes("--yes")
  );
}
