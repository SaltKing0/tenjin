// Emits an unterminated frame larger than the client's bounded stdout buffer.
process.stdout.write("x".repeat(1_100_000));
setInterval(() => {}, 1000);
