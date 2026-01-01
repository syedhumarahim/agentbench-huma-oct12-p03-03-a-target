const command: string = process.argv[2] || "help";
console.error(`Governance rollout incomplete: ${command}`);
process.exitCode = 2;
