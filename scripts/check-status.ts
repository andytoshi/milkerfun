import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getAccount } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Status checker script - shows current state of the program and user
 */
async function main() {
  // Set up provider manually to avoid env variable issues
  const connection = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com"
  );
  
  // Load wallet from default Solana CLI location
  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')))
  );
  
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const program = anchor.workspace.milkerfun as Program<Milkerfun>;

  console.log("=== MilkerFun Status ===");
  console.log("Program ID:", program.programId.toString());
  console.log("User:", wallet.publicKey.toString());
  console.log("Cluster:", provider.connection.rpcEndpoint);

  try {
    // Get config
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    
    console.log("\n=== Configuration ===");
    console.log("Admin:", config.admin.toString());
    console.log("MILK Mint:", config.milkMint.toString());
    console.log("Base Rate:", config.baseMilkPerCowPerMin.toNumber() / 1_000_000, "MILK/cow/min");
    console.log("Initial Cow Cost:", config.cowInitialCost.toNumber() / 1_000_000, "MILK");
    console.log("Start Time:", new Date(config.startTime.toNumber() * 1000).toISOString());

    // Calculate current cow price
    const currentTime = Math.floor(Date.now() / 1000);
    const elapsedHours = Math.floor((currentTime - config.startTime.toNumber()) / 3600);
    const priceMultiplier = Math.pow(2, Math.min(elapsedHours, 4));
    const currentCowPrice = (config.cowInitialCost.toNumber() * priceMultiplier) / 1_000_000;
    
    console.log("Current Cow Price:", currentCowPrice, "MILK");
    console.log("Hours Elapsed:", elapsedHours);

    // Calculate current reward rate
    const daysElapsed = Math.floor((currentTime - config.startTime.toNumber()) / 86400);
    const halvingPeriods = Math.floor(daysElapsed / 10);
    const currentRate = (config.baseMilkPerCowPerMin.toNumber() / Math.pow(2, halvingPeriods)) / 1_000_000;
    
    console.log("Current Reward Rate:", currentRate, "MILK/cow/min");
    console.log("Days Elapsed:", daysElapsed);
    console.log("Halving Periods:", halvingPeriods);

    // Check user's farm
    const [farmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("farm"), wallet.publicKey.toBuffer()],
      program.programId
    );

    try {
      const farm = await program.account.farmAccount.fetch(farmPda);
      
      console.log("\n=== User Farm ===");
      console.log("Owner:", farm.owner.toString());
      console.log("Cows:", farm.cows.toNumber());
      console.log("Accumulated Rewards:", farm.accumulatedRewards.toNumber() / 1_000_000, "MILK");
      console.log("Last Update:", new Date(farm.lastUpdateTime.toNumber() * 1000).toISOString());

      // Calculate pending rewards
      const timeSinceUpdate = currentTime - farm.lastUpdateTime.toNumber();
      const pendingRewards = (farm.cows.toNumber() * currentRate * timeSinceUpdate) / 60;
      console.log("Estimated Pending Rewards:", pendingRewards.toFixed(6), "MILK");
      
    } catch (error) {
      console.log("\n=== User Farm ===");
      console.log("Farm not initialized yet");
    }

    // Check user's token balance
    try {
      // Try to find user's token account
      const tokenAccounts = await provider.connection.getTokenAccountsByOwner(
        wallet.publicKey,
        { mint: config.milkMint }
      );

      if (tokenAccounts.value.length > 0) {
        const tokenAccount = tokenAccounts.value[0].pubkey;
        const balance = await getAccount(provider.connection, tokenAccount);
        
        console.log("\n=== User Token Balance ===");
        console.log("Token Account:", tokenAccount.toString());
        console.log("Balance:", Number(balance.amount) / 1_000_000, "MILK");
      } else {
        console.log("\n=== User Token Balance ===");
        console.log("No MILK token account found");
      }
    } catch (error) {
      console.log("Error checking token balance:", error.message);
    }

  } catch (error) {
    console.error("Error fetching status:", error.message);
  }
}

main().catch((error) => {
  console.error("Status check failed:", error);
  process.exit(1);
});