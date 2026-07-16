import express from "express";
import path from "path";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Enable JSON middleware
app.use(express.json());

const TASKS_FILE = path.join(process.cwd(), "tasks.json");
const ACCOUNTS_FILE = path.join(process.cwd(), "accounts.json");
const TOKENS_FILE = path.join(process.cwd(), "tokens.json");

function loadTasks(): any[] {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const data = fs.readFileSync(TASKS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load tasks from file:", e);
  }
  return [];
}

function saveTasks(tasks: any[]) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save tasks to file:", e);
  }
}

function loadAccounts(): any[] {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = fs.readFileSync(ACCOUNTS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load accounts from file:", e);
  }
  return [];
}

function saveAccounts(accounts: any[]) {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save accounts to file:", e);
  }
}

// Shared in-memory Activation Token database to allow multi-user sharing across devices
const SECURE_FALLBACK_TOKENS = [
  'LD-SOLO-WN4X-8BP2-YT9C',
  'LD-SOLO-7MQG-5V6K-RD4L',
  'LD-PREM-4KZ3-8X9B-PJ2W',
  'LD-PREM-9HQF-2TLK-7XMS',
  'LD-VIP-3XWY-9VPL-5NZ6',
  'LD-VIP-8RFT-4KCD-3WQZ',
  'LD-AUTH-9Y8K-4XMD-7WQP'
];

interface TokenItem {
  token: string;
  status: 'Unused' | 'Used';
}

function loadTokens(): TokenItem[] {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = fs.readFileSync(TOKENS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load tokens from file:", e);
  }
  return SECURE_FALLBACK_TOKENS.map(t => ({ token: t, status: 'Unused' as const }));
}

function saveTokens(tokens: TokenItem[]) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save tokens to file:", e);
  }
}

const tokenStore: TokenItem[] = loadTokens();
const accountsStore: any[] = loadAccounts();
let tasksStore: any[] = loadTasks();

// --- FIRESTORE INTEGRATION ENGINE ---
let firestoreDb: any = null;
let isUsingDefaultDbFallback = false;

try {
  const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(firebaseConfigPath)) {
    const config = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf-8"));
    const appInstance = !getApps().length ? initializeApp({
      projectId: config.projectId,
    }) : getApps()[0];
    const dbId = config.firestoreDatabaseId && config.firestoreDatabaseId !== "(default)"
      ? config.firestoreDatabaseId
      : undefined;
    firestoreDb = dbId ? getFirestore(appInstance, dbId) : getFirestore(appInstance);
    console.log(`[Firebase] Initialized Firestore database with ID: ${dbId || "(default)"}`);
  } else {
    console.log("[Firebase] Config file not found, falling back to JSON local file storage.");
  }
} catch (error) {
  console.error("[Firebase] Failed to initialize Firebase Admin SDK:", error);
}

function handleDatabaseError(error: any): boolean {
  if (!error) return false;
  const errMsg = error.message || "";
  const errCode = error.code;
  const isPermissionDenied = errMsg.includes("PERMISSION_DENIED");
  const isNotFound = errMsg.includes("NOT_FOUND") || errMsg.includes("not found") || errCode === 5;

  if ((isPermissionDenied || isNotFound) && !isUsingDefaultDbFallback) {
    console.warn(`[Firebase] Database error encountered (${errMsg}). Attempting self-healing fallback to default database...`);
    try {
      firestoreDb = getFirestore();
      isUsingDefaultDbFallback = true;
      return true;
    } catch (err) {
      console.error("[Firebase] Failed to fall back to default database:", err);
    }
  }
  return false;
}

// Accounts DB helpers
async function getAllAccountsFromDb(): Promise<any[]> {
  if (firestoreDb) {
    try {
      const snapshot = await firestoreDb.collection("accounts").get();
      const list: any[] = [];
      snapshot.forEach(doc => {
        list.push({ ...doc.data() });
      });
      if (list.length > 0) {
        return list;
      }
    } catch (e: any) {
      console.error("[Firebase] Error fetching accounts:", e);
      if (handleDatabaseError(e)) {
        try {
          const snapshot = await firestoreDb.collection("accounts").get();
          const list: any[] = [];
          snapshot.forEach(doc => {
            list.push({ ...doc.data() });
          });
          if (list.length > 0) {
            return list;
          }
        } catch (retryErr) {
          console.error("[Firebase] Retry fetching accounts with default database failed:", retryErr);
        }
      }
    }
  }
  return loadAccounts();
}

async function saveAccountToDb(account: any) {
  if (!account || !account.email) return;
  const emailLower = account.email.toLowerCase();
  
  // Save locally as backup
  const idx = accountsStore.findIndex((a: any) => a.email.toLowerCase() === emailLower);
  if (idx === -1) {
    accountsStore.push(account);
  } else {
    accountsStore[idx] = account;
  }
  saveAccounts(accountsStore);

  if (firestoreDb) {
    try {
      await firestoreDb.collection("accounts").doc(emailLower).set(account);
      console.log(`[Firebase] Successfully saved account to Firestore: ${emailLower}`);
    } catch (e: any) {
      console.error(`[Firebase] Error saving account ${emailLower}:`, e);
      if (handleDatabaseError(e)) {
        try {
          await firestoreDb.collection("accounts").doc(emailLower).set(account);
          console.log(`[Firebase] Successfully saved account to default Firestore: ${emailLower}`);
        } catch (retryErr) {
          console.error(`[Firebase] Retry saving account ${emailLower} with default database failed:`, retryErr);
        }
      }
    }
  }
}

async function saveAllAccountsToDb(accounts: any[]) {
  // Save locally as backup
  accountsStore.length = 0;
  accountsStore.push(...accounts);
  saveAccounts(accountsStore);

  if (firestoreDb) {
    try {
      const batch = firestoreDb.batch();
      accounts.forEach((acc: any) => {
        if (acc && acc.email) {
          const docRef = firestoreDb!.collection("accounts").doc(acc.email.toLowerCase());
          batch.set(docRef, acc);
        }
      });
      await batch.commit();
      console.log("[Firebase] Successfully batch-saved all accounts to Firestore.");
    } catch (e: any) {
      console.error("[Firebase] Error bulk saving accounts:", e);
      if (handleDatabaseError(e)) {
        try {
          const batch = firestoreDb.batch();
          accounts.forEach((acc: any) => {
            if (acc && acc.email) {
              const docRef = firestoreDb!.collection("accounts").doc(acc.email.toLowerCase());
              batch.set(docRef, acc);
            }
          });
          await batch.commit();
          console.log("[Firebase] Successfully batch-saved all accounts to default Firestore.");
        } catch (retryErr) {
          console.error("[Firebase] Retry bulk saving accounts with default database failed:", retryErr);
        }
      }
    }
  }
}

// Tasks DB helpers
async function getAllTasksFromDb(): Promise<any[]> {
  if (firestoreDb) {
    try {
      const snapshot = await firestoreDb.collection("tasks").get();
      const list: any[] = [];
      snapshot.forEach(doc => {
        list.push({ ...doc.data() });
      });
      if (list.length > 0) {
        return list;
      }
    } catch (e: any) {
      console.error("[Firebase] Error fetching tasks:", e);
      if (handleDatabaseError(e)) {
        try {
          const snapshot = await firestoreDb.collection("tasks").get();
          const list: any[] = [];
          snapshot.forEach(doc => {
            list.push({ ...doc.data() });
          });
          if (list.length > 0) {
            return list;
          }
        } catch (retryErr) {
          console.error("[Firebase] Retry fetching tasks with default database failed:", retryErr);
        }
      }
    }
  }
  return loadTasks();
}

async function saveAllTasksToDb(tasks: any[]) {
  tasksStore = tasks;
  saveTasks(tasks);

  if (firestoreDb) {
    try {
      const batch = firestoreDb.batch();
      tasks.forEach((task: any) => {
        if (task && task.id) {
          const docRef = firestoreDb!.collection("tasks").doc(task.id);
          batch.set(docRef, task);
        }
      });
      await batch.commit();
      console.log("[Firebase] Successfully batch-saved all tasks to Firestore.");
    } catch (e: any) {
      console.error("[Firebase] Error bulk saving tasks:", e);
      if (handleDatabaseError(e)) {
        try {
          const batch = firestoreDb.batch();
          tasks.forEach((task: any) => {
            if (task && task.id) {
              const docRef = firestoreDb!.collection("tasks").doc(task.id);
              batch.set(docRef, task);
            }
          });
          await batch.commit();
          console.log("[Firebase] Successfully batch-saved all tasks to default Firestore.");
        } catch (retryErr) {
          console.error("[Firebase] Retry bulk saving tasks with default database failed:", retryErr);
        }
      }
    }
  }
}

// Tokens DB helpers
async function getAllTokensFromDb(): Promise<TokenItem[]> {
  if (firestoreDb) {
    try {
      const snapshot = await firestoreDb.collection("tokens").get();
      const list: TokenItem[] = [];
      snapshot.forEach(doc => {
        list.push(doc.data() as TokenItem);
      });
      if (list.length > 0) {
        return list;
      }
    } catch (e: any) {
      console.error("[Firebase] Error fetching tokens:", e);
      if (handleDatabaseError(e)) {
        try {
          const snapshot = await firestoreDb.collection("tokens").get();
          const list: TokenItem[] = [];
          snapshot.forEach(doc => {
            list.push(doc.data() as TokenItem);
          });
          if (list.length > 0) {
            return list;
          }
        } catch (retryErr) {
          console.error("[Firebase] Retry fetching tokens with default database failed:", retryErr);
        }
      }
    }
  }
  return loadTokens();
}

async function saveAllTokensToDb(tokens: TokenItem[]) {
  tokenStore.length = 0;
  tokenStore.push(...tokens);
  saveTokens(tokens);

  if (firestoreDb) {
    try {
      const batch = firestoreDb.batch();
      tokens.forEach((t: TokenItem) => {
        if (t && t.token) {
          const docRef = firestoreDb!.collection("tokens").doc(t.token.trim().toUpperCase());
          batch.set(docRef, t);
        }
      });
      await batch.commit();
      console.log("[Firebase] Successfully batch-saved all tokens to Firestore.");
    } catch (e: any) {
      console.error("[Firebase] Error bulk saving tokens:", e);
      if (handleDatabaseError(e)) {
        try {
          const batch = firestoreDb.batch();
          tokens.forEach((t: TokenItem) => {
            if (t && t.token) {
              const docRef = firestoreDb!.collection("tokens").doc(t.token.trim().toUpperCase());
              batch.set(docRef, t);
            }
          });
          await batch.commit();
          console.log("[Firebase] Successfully batch-saved all tokens to default Firestore.");
        } catch (retryErr) {
          console.error("[Firebase] Retry bulk saving tokens with default database failed:", retryErr);
        }
      }
    }
  }
}

async function saveTokenToDb(token: TokenItem) {
  if (!token || !token.token) return;
  const formattedToken = token.token.trim().toUpperCase();

  const idx = tokenStore.findIndex(t => t.token === formattedToken);
  if (idx === -1) {
    tokenStore.push(token);
  } else {
    tokenStore[idx] = token;
  }
  saveTokens(tokenStore);

  if (firestoreDb) {
    try {
      await firestoreDb.collection("tokens").doc(formattedToken).set(token);
      console.log(`[Firebase] Successfully saved token to Firestore: ${formattedToken}`);
    } catch (e: any) {
      console.error(`[Firebase] Error saving token ${formattedToken}:`, e);
      if (handleDatabaseError(e)) {
        try {
          await firestoreDb.collection("tokens").doc(formattedToken).set(token);
          console.log(`[Firebase] Successfully saved token to default Firestore: ${formattedToken}`);
        } catch (retryErr) {
          console.error(`[Firebase] Retry saving token ${formattedToken} with default database failed:`, retryErr);
        }
      }
    }
  }
}

async function deleteTokenFromDb(tokenValue: string) {
  const formattedToken = tokenValue.trim().toUpperCase();
  const index = tokenStore.findIndex(t => t.token === formattedToken);
  if (index !== -1) {
    tokenStore.splice(index, 1);
    saveTokens(tokenStore);
  }

  if (firestoreDb) {
    try {
      await firestoreDb.collection("tokens").doc(formattedToken).delete();
      console.log(`[Firebase] Successfully deleted token from Firestore: ${formattedToken}`);
    } catch (e: any) {
      console.error(`[Firebase] Error deleting token ${formattedToken}:`, e);
      if (handleDatabaseError(e)) {
        try {
          await firestoreDb.collection("tokens").doc(formattedToken).delete();
          console.log(`[Firebase] Successfully deleted token from default Firestore: ${formattedToken}`);
        } catch (retryErr) {
          console.error(`[Firebase] Retry deleting token ${formattedToken} with default database failed:`, retryErr);
        }
      }
    }
  }
}

// API endpoint to fetch all active tokens
app.get("/api/tokens", async (req, res) => {
  try {
    const list = await getAllTokensFromDb();
    res.json({
      success: true,
      tokens: list
    });
  } catch (err) {
    res.json({
      success: true,
      tokens: tokenStore
    });
  }
});

// API endpoint to submit/generate a new token
app.post("/api/tokens/generate", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: "Token is required." });
  }
  const formattedToken = token.trim().toUpperCase();
  try {
    const currentTokens = await getAllTokensFromDb();
    const existing = currentTokens.find(t => t.token === formattedToken);
    if (!existing) {
      const newTokenItem = { token: formattedToken, status: 'Unused' as const };
      await saveTokenToDb(newTokenItem);
    }
  } catch (err) {
    console.error("[Firebase] Error generating token:", err);
  }
  res.json({ success: true, tokens: tokenStore });
});

// API endpoint to validate and consume a token
app.post("/api/tokens/validate", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: "Token is required." });
  }
  const formattedToken = token.trim().toUpperCase();
  try {
    const currentTokens = await getAllTokensFromDb();
    const match = currentTokens.find(t => t.token === formattedToken);
    
    if (!match) {
      return res.status(400).json({
        success: false,
        error: "Invalid Activation Token. Please buy a unique code from our verified Vendor Agents below."
      });
    }
    
    if (match.status === 'Used') {
      return res.status(400).json({
        success: false,
        error: "This activation token has already been used by another user."
      });
    }
    
    // Mark as used
    match.status = 'Used';
    await saveTokenToDb(match);
    
    // Extract plan
    let plan = "Solo";
    if (formattedToken.includes('PREM')) plan = "Prem";
    else if (formattedToken.includes('VIP')) plan = "Vip";
    
    res.json({
      success: true,
      plan,
      token: formattedToken
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Internal validation error." });
  }
});

// API endpoint to retrieve the public key for Paystack
app.get("/api/paystack/config", (req, res) => {
  const publicKey = process.env.VITE_PAYSTACK_PUBLIC_KEY || process.env.PAYSTACK_PUBLIC_KEY || "pk_test_4107128cf7e8574d75fcd6f4693a0279c93433a0";
  res.json({ publicKey });
});

// API endpoint to handle successful Paystack payment and generate an activation token
app.post("/api/paystack/success", async (req, res) => {
  const { plan, reference, email, amount } = req.body;
  if (!plan) {
    return res.status(400).json({ success: false, error: "Plan is required." });
  }

  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const genPart = (length: number) => {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  };

  const planUpper = plan.toUpperCase().substring(0, 4);
  const tokenValue = `LD-${planUpper}-${genPart(4)}-${genPart(4)}`;

  try {
    const newToken = { token: tokenValue, status: 'Unused' as const };
    await saveTokenToDb(newToken);
  } catch (err) {
    console.error("[Firebase] Error saving Paystack success token:", err);
  }

  console.log(`[Paystack Success] Generated token ${tokenValue} for plan ${plan}, reference ${reference}, email ${email}`);

  res.json({
    success: true,
    token: tokenValue,
    plan
  });
});

// API endpoint to revoke a token
app.post("/api/tokens/revoke", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: "Token is required." });
  }
  try {
    await deleteTokenFromDb(token);
  } catch (err) {
    console.error("[Firebase] Error revoking token:", err);
  }
  res.json({ success: true, tokens: tokenStore });
});

// API endpoint to sync local custom tokens to the server
app.post("/api/tokens/sync", async (req, res) => {
  const { tokens } = req.body;
  if (Array.isArray(tokens)) {
    try {
      const currentTokens = await getAllTokensFromDb();
      let changed = false;
      tokens.forEach((item: any) => {
        if (item && typeof item.token === 'string') {
          const formatted = item.token.trim().toUpperCase();
          const existing = currentTokens.find(t => t.token === formatted);
          if (!existing) {
            currentTokens.push({
              token: formatted,
              status: item.status === 'Used' ? 'Used' : 'Unused'
            });
            changed = true;
          } else if (item.status === 'Used' && existing.status === 'Unused') {
            existing.status = 'Used';
            changed = true;
          }
        }
      });
      if (changed) {
        await saveAllTokensToDb(currentTokens);
      }
    } catch (err) {
      console.error("[Firebase] Error syncing tokens:", err);
    }
  }
  res.json({ success: true, tokens: tokenStore });
});

// Helper function to expire tasks older than 24 hours
async function checkTasksStoreExpiration() {
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  let changed = false;
  
  try {
    const currentTasks = await getAllTasksFromDb();
    const updatedTasks = currentTasks.map(task => {
      if (task.status !== 'Available') return task;

      let createdAtMs = now;
      if (task.createdAt) {
        const parsed = Date.parse(task.createdAt);
        if (!isNaN(parsed)) createdAtMs = parsed;
      } else if (task.id && task.id.startsWith('task-admin-')) {
        const tsStr = task.id.replace('task-admin-', '').split('_')[0];
        const parsedTs = parseInt(tsStr, 10);
        if (!isNaN(parsedTs)) createdAtMs = parsedTs;
      } else {
        task.createdAt = new Date().toISOString();
        createdAtMs = now;
        changed = true;
      }

      if (now - createdAtMs > twentyFourHours) {
        changed = true;
        return {
          ...task,
          status: 'Expired'
        };
      }
      return task;
    });

    if (changed) {
      await saveAllTasksToDb(updatedTasks);
    } else {
      tasksStore = updatedTasks;
    }
  } catch (err) {
    console.error("[Firebase] Error checking task expiration:", err);
  }
}

// API endpoint to fetch current active daily tasks
app.get("/api/tasks", async (req, res) => {
  await checkTasksStoreExpiration();
  res.json({
    success: true,
    tasks: tasksStore
  });
});

// API endpoint to update or synchronize the master list of tasks (e.g. from the admin portal)
app.post("/api/tasks/sync", async (req, res) => {
  const { tasks } = req.body;
  if (Array.isArray(tasks)) {
    try {
      const updatedTasks = tasks.map(t => ({
        ...t,
        status: t.status === 'Completed' || t.status === 'Verifying' ? 'Available' : t.status
      }));
      await saveAllTasksToDb(updatedTasks);
      await checkTasksStoreExpiration();
    } catch (err) {
      console.error("[Firebase] Error syncing tasks:", err);
    }
  }
  res.json({
    success: true,
    tasks: tasksStore
  });
});

// Ensure default admin account and initial database synchronization runs in the background
async function initializeDbWithFirestore() {
  console.log("[Firebase] Starting database synchronization from Firestore...");
  try {
    // Sync accounts
    const dbAccounts = await getAllAccountsFromDb();
    accountsStore.length = 0;
    accountsStore.push(...dbAccounts);
    
    // Ensure the default pioneer admin account is always present in the store on startup
    const defaultAdminEmail = "livingstone0806382@gmail.com";
    const adminIdx = accountsStore.findIndex(a => a && a.email && a.email.toLowerCase() === defaultAdminEmail);
    if (adminIdx === -1) {
      const defaultAdmin = {
        email: defaultAdminEmail,
        password: "Stone44@",
        fullName: "John Doe",
        profileLevel: "Solo",
        totalBalance: 3500,
        availableWithdrawal: 3500,
        referralEarnings: 0,
        referralBalance: 0,
        taskBalance: 3500,
        totalReferrals: 0,
        referralsList: [],
        activitiesList: [
          {
            id: "BY-5775",
            type: "Bonus",
            title: "First-Time Login Bonus",
            amount: 3500,
            isCredit: true,
            timestamp: "2026-06-30 16:59",
            details: "₦3,500 welcome bonus credited automatically upon your first-time login.",
            status: "Successful"
          }
        ],
        refSlug: "LD-SOLO-PIONEER",
        refCode: "PIONEER",
        profilePhoto: null,
        tasks: []
      };
      accountsStore.push(defaultAdmin);
      await saveAccountToDb(defaultAdmin);
    } else {
      if (accountsStore[adminIdx].password !== "Stone44@") {
        accountsStore[adminIdx].password = "Stone44@";
        await saveAccountToDb(accountsStore[adminIdx]);
      }
    }

    // Sync tasks
    const dbTasks = await getAllTasksFromDb();
    tasksStore.length = 0;
    tasksStore.push(...dbTasks);

    // Sync tokens
    const dbTokens = await getAllTokensFromDb();
    tokenStore.length = 0;
    tokenStore.push(...dbTokens);
    
    // If Firestore was empty or only had fallback ones, write fallback tokens
    if (dbTokens.length === SECURE_FALLBACK_TOKENS.length) {
      await saveAllTokensToDb(dbTokens);
    }

    console.log("[Firebase] Database synchronization complete.");
  } catch (err) {
    console.error("[Firebase] Database synchronization failed, using local fallback:", err);
  }
}

// Fire off database initialization
initializeDbWithFirestore();

// API endpoint to fetch all registered accounts
app.get("/api/accounts", async (req, res) => {
  try {
    const list = await getAllAccountsFromDb();
    res.json({
      success: true,
      accounts: list
    });
  } catch (err) {
    res.json({
      success: true,
      accounts: accountsStore
    });
  }
});

// API endpoint to synchronize accounts database
app.post("/api/accounts/sync", async (req, res) => {
  const { accounts } = req.body;
  if (Array.isArray(accounts)) {
    try {
      const currentAccounts = await getAllAccountsFromDb();
      accounts.forEach((localAcc: any) => {
        if (!localAcc || !localAcc.email) return;
        const existingIdx = currentAccounts.findIndex(
          (s: any) => s.email.toLowerCase() === localAcc.email.toLowerCase()
        );
        if (existingIdx === -1) {
          currentAccounts.push(localAcc);
        } else {
          const currentServerAcc = currentAccounts[existingIdx];
          
          // Merge referrals list safely
          const mergedReferrals = [...(currentServerAcc.referralsList || [])];
          (localAcc.referralsList || []).forEach((lr: any) => {
            if (!mergedReferrals.some((mr: any) => mr.email?.toLowerCase() === lr.email?.toLowerCase())) {
              mergedReferrals.push(lr);
            }
          });

          // Merge activities list safely (most recent first)
          const mergedActivities = [...(currentServerAcc.activitiesList || [])];
          (localAcc.activitiesList || []).forEach((la: any) => {
            if (!mergedActivities.some((ma: any) => ma.id === la.id)) {
              mergedActivities.unshift(la);
            }
          });

          // Merge tasks safely
          const mergedTasks = [...(currentServerAcc.tasks || [])];
          (localAcc.tasks || []).forEach((lt: any) => {
            const matchIdx = mergedTasks.findIndex((mt: any) => mt.id === lt.id);
            if (matchIdx === -1) {
              mergedTasks.push(lt);
            } else {
              const mt = mergedTasks[matchIdx];
              if (mt.status === 'Completed') {
                // Keep server Completed status
              } else if (lt.status === 'Completed') {
                mergedTasks[matchIdx] = { ...mt, ...lt, status: 'Completed' };
              } else if (lt.status === 'Verifying') {
                mergedTasks[matchIdx] = { ...mt, ...lt, status: 'Verifying' };
              } else {
                mergedTasks[matchIdx] = { ...mt, ...lt, status: mt.status };
              }
            }
          });

          // Merge and update
          currentAccounts[existingIdx] = {
            ...currentServerAcc,
            ...localAcc,
            referralsList: mergedReferrals,
            activitiesList: mergedActivities,
            tasks: mergedTasks,
            // Handle max values to keep highest balance across sessions
            totalBalance: Math.max(currentServerAcc.totalBalance || 0, localAcc.totalBalance || 0),
            availableWithdrawal: Math.max(currentServerAcc.availableWithdrawal || 0, localAcc.availableWithdrawal || 0),
            referralEarnings: Math.max(currentServerAcc.referralEarnings || 0, localAcc.referralEarnings || 0),
            referralBalance: Math.max(currentServerAcc.referralBalance || 0, localAcc.referralBalance || 0),
            totalReferrals: Math.max(mergedReferrals.length, currentServerAcc.totalReferrals || 0, localAcc.totalReferrals || 0),
          };
        }
      });
      await saveAllAccountsToDb(currentAccounts);
    } catch (err) {
      console.error("[Firebase] Sync failed, merging to memory only:", err);
    }
  }
  res.json({
    success: true,
    accounts: accountsStore
  });
});

// API route to send OTP
app.post("/api/send-otp", async (req, res) => {
  const { recipient, otpCode } = req.body;

  if (!recipient || !otpCode) {
    return res.status(400).json({
      success: false,
      error: "Recipient and verification code are required.",
    });
  }

  const isEmail = recipient.includes("@");

  // Determine if SMTP parameters are configured
  let smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  if (smtpHost.toLowerCase().trim() === "gmail") {
    smtpHost = "smtp.gmail.com";
  }
  const smtpPortStr = process.env.SMTP_PORT || "465";
  const smtpPort = parseInt(smtpPortStr, 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const emailFrom = process.env.EMAIL_FROM || "ldearn Security <no-reply@ldearn.com.ng>";

  // If parameters are missing, handle gracefully (sandbox mode)
  if (!smtpUser || !smtpPass) {
    return res.json({
      success: true,
      isRealEmail: false,
      reason: "SMTP_NOT_CONFIGURED",
      message: "Simulation active: Set SMTP credentials (SMTP_USER/SMTP_PASS) in AI Studio Secrets to send real emails.",
    });
  }

  // If it's a phone number, we simulate it as we don't have an SMS gateway configured
  if (!isEmail) {
    return res.json({
      success: true,
      isRealEmail: false,
      reason: "PHONE_NOT_SUPPORTED",
      message: "SMS dispatch simulation successful. To receive physical emails, specify a valid email address.",
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // Use true for active standard 465 SSL, false for others
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const mailOptions = {
      from: emailFrom,
      to: recipient.trim(),
      subject: `🔒 ldearn Secure Passcode Recovery: ${otpCode}`,
      text: `Hello,\n\nWe received a secure credentials lookup check from your device.\n\nYour secure 6-digit confirmation key is: ${otpCode}\n\nSimply input this key in your password recovery screen to update your active browser profile configuration.\n\nIf you did not request this code, please ignore this message.\n\nWarm regards,\nldearn Security Team`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #f8fafc;">
          <h2 style="font-size: 18px; font-weight: bold; color: #1e293b; margin-top: 0; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid #22c55e; padding-bottom: 8px;">
            🔒 ldearn Access Recovery
          </h2>
          <p style="font-size: 14px; color: #475569; line-height: 1.5; margin-bottom: 16px;">
            Hello user,
          </p>
          <p style="font-size: 14px; color: #475569; line-height: 1.5; margin-bottom: 20px;">
            We received a secure credentials lookup check from your device. Please use the high-availability security passcode below to synchronize your browser storage and reset your password safely:
          </p>
          <div style="text-align: center; background-color: #0f172a; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
            <strong style="font-family: monospace; font-size: 28px; font-weight: bold; color: #4ade80; letter-spacing: 4px; display: block;">
              ${otpCode}
            </strong>
          </div>
          <p style="font-size: 12px; color: #64748b; line-height: 1.5; margin-bottom: 24px; font-style: italic;">
            Note: This authorization check is only valid for your current browser session. Do not share this code with anyone.
          </p>
          <hr style="border: 0; border-top: 1px solid #cbd5e1; margin-bottom: 16px;" />
          <p style="font-size: 11px; text-align: center; color: #94a3b8; font-family: monospace; text-transform: uppercase;">
            LD NAIRA TOKEN CO. &copy; 2026 // SECURE CLIENT LEDGER
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    return res.json({
      success: true,
      isRealEmail: true,
      message: "Real email OTP dispatched successfully!",
    });
  } catch (err: any) {
    console.error("Nodemailer error caught gracefully: ", err);
    // Graceful fallback to simulated sandbox delivery so the user is never locked out on SMTP/network errors
    return res.json({
      success: true,
      isRealEmail: false,
      reason: "SMTP_ERROR",
      message: `We attempted to send a real email, but the SMTP provider failed (${err?.message || "Connection issue"}). Falling back to local simulated screen delivery.`,
    });
  }
});

// Configure Vite integration or static file serving
async function setupViteOrStatic() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

setupViteOrStatic();
