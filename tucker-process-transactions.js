import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from 'crypto';

// Initialize DynamoDB client
const client = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(client);
const TABLE_NAME = 'Merchant';
const LOG_TABLE_NAME = 'TransactionLog'; // Define log table name as a constant

// Clearinghouse credentials
const CH_ACCT_NUM = "Tucker Morin";
const CH_TOKEN = "521679";

// Bank API URLs
const CHASE = "https://l4biqzlvcftgrvndcqbixb64x40bzkxj.lambda-url.us-west-1.on.aws";
const CITIBANK = "https://3p6ek2m7p4mrlraaxnw7qc7rry0hxvwf.lambda-url.us-west-1.on.aws/";

// Transaction logging function
const logTransaction = async (merchant, token, bank, cc_number, amount, result) => {
  const uniqueId = randomUUID();
  
  const params = {
    TableName: LOG_TABLE_NAME,
    Item: {
      transaction_id: uniqueId,
      amount: amount,
      bank: bank, 
      bank_acct_num: cc_number, 
      merchant_name: merchant,
      merchant_token: token, 
      status: result, 
      timestamp: new Date().toISOString(), // Current timestamp
    },
  };

  try {
    const data = await dynamoDb.send(new PutCommand(params));
    console.log("Transaction recorded:", data);
  } catch (err) {
    console.error("Error recording transaction:", err);
  }
};

// Helper to wrap fetch with a timeout
const fetchWithTimeout = (url, payload, timeoutMs) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Citibank Not Available. Timed out after 5 seconds"));
    }, timeoutMs);

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (response) => {
        clearTimeout(timeout);
        if (!response.ok) {
          throw new Error(`Bank API error: ${response.status} - ${await response.text()}`);
        }
        return response.json();
      })
      .then(resolve)
      .catch((error) => {
        clearTimeout(timeout);
        console.error("Transaction Error:", error);
        reject(new Error("Error processing transaction."));
      });
  });
};

// Exponential backoff retry: 2s, 4s, 8s
const retryWithBackoff = async (url, payload) => {
  const delays = [0, 2000, 4000, 8000]; // includes immediate first attempt
  for (let i = 0; i < delays.length; i++) {
    try {
      if (delays[i] > 0) {
        console.log(`⏳ Waiting ${delays[i]}ms before retry #${i}`);
        await new Promise(res => setTimeout(res, delays[i]));
      }
      console.log(`🔁 Attempt ${i + 1}`);
      return await fetchWithTimeout(url, payload, 5000);
    } catch (err) {
      console.warn(`Attempt ${i + 1} failed: ${err.message}`);
      if (i === delays.length - 1) throw err;
    }
  }
};

export const handler = async (event) => {
  try {
    const requestBody = JSON.parse(event.body);
    console.log("Request Body:", requestBody);

    // Healthcheck support
    if (requestBody.healthcheck) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Clearinghouse API Alive." }),
      };
    }

    const merchant_name = requestBody.merchant_name;
    const merchant_token = requestBody.merchant_token;

    // Validate merchant credentials
    if (!merchant_name || !merchant_token) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Merchant name and token are required." }),
      };
    }

    if (typeof merchant_name !== 'string' || typeof merchant_token !== 'string') {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Merchant name and token must be strings." }),
      };
    }

    // DynamoDB merchant lookup
    const params = {
      TableName: TABLE_NAME,
      Key: {
        "MerchantName": merchant_name,
        "Token": merchant_token
      }
    };

    let result;
    try {
      result = await dynamoDb.send(new GetCommand(params));
    } catch (dbError) {
      console.error("DynamoDB Error:", dbError);
      return {
        statusCode: 500,
        body: JSON.stringify({ message: "Error accessing merchant data." }),
      };
    }

    if (!result.Item) {
      // Log failed merchant authentication
      await logTransaction(
        merchant_name, 
        merchant_token, 
        requestBody.bank || "unknown", 
        requestBody.bank_acct_num || requestBody.cc_number || "unknown", 
        requestBody.amount || 0, 
        "MERCHANT_NOT_AUTHORIZED"
      );
      
      return {
        statusCode: 403,
        body: JSON.stringify({ message: "Merchant Not Authorized" }),
      };
    }

    const bank = requestBody.bank;
    const bank_acct_num = requestBody.bank_acct_num || requestBody.cc_number;
    const amount = requestBody.amount;
    console.log("Bank:", bank);
    console.log("Bank Acct Num:", bank_acct_num);
    console.log("Amount:", amount);

    if (!bank_acct_num || !amount) {
      // Log missing required fields
      await logTransaction(
        merchant_name, 
        merchant_token, 
        bank || "unknown", 
        bank_acct_num || "unknown", 
        amount || 0, 
        "MISSING_REQUIRED_FIELDS"
      );
      
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "bank_acct_num (or cc_number) and amount are required." }),
      };
    }

    if (typeof amount !== 'number' || amount <= 0) {
      // Log invalid amount
      await logTransaction(
        merchant_name, 
        merchant_token, 
        bank || "unknown", 
        bank_acct_num, 
        amount, 
        "INVALID_AMOUNT"
      );
      
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Amount must be a positive number." }),
      };
    }

    const payload = {
      ch_acct_num: CH_ACCT_NUM,
      ch_token: CH_TOKEN,
      bank_acct_num: bank_acct_num,
      amount: amount,
    };

    // Fix for Citibank URL issue - set the correct URL based on bank
    let url = CHASE; // Default to Chase
    if (bank === "Citibank") {
      url = CITIBANK; // Use Citibank URL if specified
    }
    
    console.log("URL:", url);
    console.log("Outgoing payload:", payload);

    let bankResult;
    try {
      bankResult = await retryWithBackoff(url, payload);
      
      // Log successful transaction
      await logTransaction(
        merchant_name, 
        merchant_token, 
        bank || "Chase", // Default to Chase if not specified
        bank_acct_num, 
        amount, 
        "SUCCESS"
      );
      
      return {
        statusCode: 200,
        body: JSON.stringify({ message: bankResult.message }),
      };
    } catch (error) {
      // Log bank error
      await logTransaction(
        merchant_name, 
        merchant_token, 
        bank || "Chase", // Default to Chase if not specified
        bank_acct_num, 
        amount, 
        "BANK_ERROR"
      );
      
      return {
        statusCode: 502,
        body: JSON.stringify({ message: error.message }),
      };
    }

  } catch (error) {
    console.error("Unhandled Error:", error);
    
    // Attempt to log unhandled error
    try {
      await logTransaction(
        "unknown", 
        "unknown", 
        "unknown", 
        "unknown", 
        0, 
        "UNHANDLED_ERROR: " + error.message
      );
    } catch (logError) {
      console.error("Failed to log error transaction:", logError);
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message
      }),
    };
  }
};