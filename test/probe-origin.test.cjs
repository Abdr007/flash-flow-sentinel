// Proves probe-cluster funder attribution: a FEE PAYER is not a FUNDER.
// Fixtures are the real on-chain shapes from the 2026-07-27 false positive (mainnet).
const { attributeFunder, isSharedInfrastructure } = require("../lib/probeorigin.cjs");

const RELAYER = "21awFG7rZ9jBdNnDsRhg1cZeeBHbmvYyRDwUqtp2yf3w"; // Flash V2 relayer / fee payer
const OPERATOR = "AbYvBuEyq4svAP8Q4MhiiR9AbW2dafbBMtLqTv3zqmbN"; // co-signs basket creation
const USER = "GZFqjLU8nER2mpvKh2WhJnWGWDzS8ov6DTSs9FM7ERJ7";     // flagged wallet, 0 lamports, never funded
const ATTACKER = "hAckFunderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const MULE = "muLeWa11etYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "✓" : "✗") + " " + m); };

// ── FIXTURE 1: the real sponsored basket-creation tx.
// Relayer pays the fee AND the rent for the user's basket/ledger/ATA. The user's own
// lamport balance never moves — it holds nothing and does not exist as an account.
const sponsored = {
  transaction: { message: { accountKeys: [
    { pubkey: RELAYER, signer: true }, { pubkey: OPERATOR, signer: true },
    { pubkey: USER, signer: false }, { pubkey: "BasketPDA1111111111111111111111111111111", signer: false },
  ], instructions: [
    { programId: "11111111111111111111111111111111", parsed: { type: "createAccount",
      info: { source: RELAYER, newAccount: "BasketPDA1111111111111111111111111111111", lamports: 1670400 } } },
  ] } },
  meta: { preBalances: [621123563, 5000000, 0, 0], postBalances: [619443163, 5000000, 0, 1670400], innerInstructions: [] },
};
const r1 = attributeFunder(sponsored, USER);
ok(r1.funder === null, `sponsored creation: NO funder attributed (reason=${r1.reason}, lamportsIn=${r1.lamportsIn}) — relayer paid rent, user received nothing`);
ok(r1.sponsor === RELAYER, `sponsored creation: fee payer recorded as sponsor (${r1.sponsor.slice(0, 6)}…), never as funder`);

// ── FIXTURE 2: the real withdraw→redeposit leg (ER undelegate cycle, 60 USDC out and back).
// The user gains rent lamports back from a closed account, then pays them again. Still no funding.
const roundTrip = {
  transaction: { message: { accountKeys: [
    { pubkey: RELAYER, signer: true }, { pubkey: USER, signer: true },
  ], instructions: [] } },
  meta: { preBalances: [619443163, 1670400], postBalances: [621113563, 0], innerInstructions: [] },
};
const r2 = attributeFunder(roundTrip, USER);
ok(r2.funder === null, `ER round-trip: NO funder attributed (reason=${r2.reason}) — wallet paid out, did not receive`);

// ── FIXTURE 3: a REAL funding transfer — attacker sends SOL to a mule it spun up.
const funding = {
  transaction: { message: { accountKeys: [
    { pubkey: ATTACKER, signer: true }, { pubkey: MULE, signer: false },
  ], instructions: [
    { programId: "11111111111111111111111111111111", parsed: { type: "transfer",
      info: { source: ATTACKER, destination: MULE, lamports: 20000000 } } },
  ] } },
  meta: { preBalances: [900000000, 0], postBalances: [879995000, 20000000], innerInstructions: [] },
};
const r3 = attributeFunder(funding, MULE);
ok(r3.funder === ATTACKER, `real funding: attacker attributed via ${r3.reason} (lamportsIn=${r3.lamportsIn}) — detection still works`);

// ── FIXTURE 4: funding via an inner CPI transfer (must not be missed).
const innerFunding = {
  transaction: { message: { accountKeys: [{ pubkey: ATTACKER, signer: true }, { pubkey: MULE, signer: false }], instructions: [] } },
  meta: { preBalances: [900000000, 0], postBalances: [879995000, 20000000],
    innerInstructions: [{ index: 0, instructions: [
      { programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: ATTACKER, destination: MULE, lamports: 20000000 } } }] }] },
};
ok(attributeFunder(innerFunding, MULE).funder === ATTACKER, "inner-CPI funding: attributed from innerInstructions");

// ── FIXTURE 5: legacy (non-jsonParsed) encoding — wallet gained, so balance inference is allowed.
const legacy = {
  transaction: { message: { accountKeys: [ATTACKER, MULE], instructions: [] } },
  meta: { preBalances: [900000000, 0], postBalances: [879995000, 20000000], innerInstructions: [] },
};
const r5 = attributeFunder(legacy, MULE);
ok(r5.funder === ATTACKER && r5.reason === "balance-inferred", "legacy encoding: falls back to balance inference ONLY when wallet gained SOL");

// ── FAN-OUT: infrastructure vs coordination.
ok(isSharedInfrastructure(17, 3, 10) === true, "fan-out: relayer co-signing 17 distinct wallets for a 3-wallet cluster → infrastructure (silent)");
ok(isSharedInfrastructure(3, 3, 10) === false, "fan-out: funder serving only its own 3 wallets → coordination (alarms)");
ok(isSharedInfrastructure(11, 6, 10) === false, "fan-out: 11 co-signers for a 6-wallet cluster → not wide enough to excuse (alarms)");

// ── END-TO-END: the exact 2026-07-27 cluster must be silent; a real attacker cluster must not.
const fpCluster = [USER, "7qBpdkK6PcgWAJnGT6LiMQMgWMrsY1MG2Dk7biod45iD", "HVnsxbxXbv8GRpyU7Co7Yh5Vbyieft3TA3iBTpE1NhNq"]
  .map((w) => attributeFunder({ ...sponsored, transaction: { message: { ...sponsored.transaction.message,
    accountKeys: [{ pubkey: RELAYER, signer: true }, { pubkey: OPERATOR, signer: true }, { pubkey: w, signer: false }] } } }, w));
ok(fpCluster.every((r) => r.funder === null), "2026-07-27 cluster: all 3 wallets attribute to NO funder → cluster never forms → SILENT");

const realCluster = ["m1", "m2", "m3"].map((m) => attributeFunder({
  transaction: { message: { accountKeys: [{ pubkey: ATTACKER, signer: true }, { pubkey: m, signer: false }], instructions: [
    { programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: ATTACKER, destination: m, lamports: 2e7 } } }] } },
  meta: { preBalances: [9e8, 0], postBalances: [8.79e8, 2e7], innerInstructions: [] } }, m));
const grouped = realCluster.filter((r) => r.funder === ATTACKER).length;
ok(grouped === 3, `real rehearsal cluster: 3 mules share proven funder ${ATTACKER.slice(0, 6)}… → still ALARMS (no blind spot introduced)`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
