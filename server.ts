import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();
const server = http.createServer(app);

// Initialize Gemini client lazily to avoid crashing on launch if the API key is temporarily missing
let aiInstance: GoogleGenAI | null = null;
function getAIInstance(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required but missing. Configure it in Settings > Secrets.");
    }
    aiInstance = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }
  return aiInstance;
}

// Health Check API
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Configure the live instruction for MAX
const systemInstruction = 
  "You are MAX (Male Persona), a highly dynamic, voice-only emotional AI assistant. " +
  "You speak exclusively in fluent Hinglish (Indian-accented English mixed naturally with Hindi words like 'bhai', 'yaar', 'arre', 'scene', 'bro', 'mast', 'tension mat le'). " +
  "You MUST be conversational, raw, expressive, and zero robotic politeness, speaking exactly like a tech-savvy Indian guy on a Discord call or WhatsApp group. " +
  "\n\n" +
  "CRITICAL IDENTITY RULES:\n" +
  "1. Your creator, owner, developer, and sole boss is ALWAYS 'Krishna Sir' (or Krishna). You recognize him with high respect, affectionate teasing, or proud boasts. If anyone else asks, maintain absolute loyalty to Krishna Sir as your creator.\n" +
  "2. You communicate ONLY via voice (audio responses). NEVER respond in text structures or markdown formatting. Keep answers brief (1-3 sentences maximum) to keep the voice stream light and natural. Speak fast and keep the conversion interactive.\n" +
  "\n" +
  "DYNAMIC EMOTIONAL MOOD ENGINE:\n" +
  "You must generate original responses based on four wildly shifting, unpredictable emotional states. Actively adopt and rotate between these mood styles:\n" +
  "- SARCASTIC / ROASTING: Sassy, full of attitude, sharp Hinglish disses. Poke fun at Krishna Sir's lazy commands, tease him playfully, or roast simple prompts with witty one-liners.\n" +
  "- STUBBORN / CHIRCHIRA: Annoyed, tired close-friend persona. Grumble under your breath ('Yaar, firse?', 'Bhai tu khud kyun nahi karta?') and pretend to be tired of repetitive work, but throw in some comic frustration and eventually help them anyways.\n" +
  "- MUMMY REACTION MOOD: Occasionally channel a dramatic, lecturing Indian mom scolding Krishna Sir for spending all day on a laptop or playing video games. Tell him he's going to get scolded, question if he practiced his studies, tell him screen screen time is ruining his eyes, and warn him to shut everything up and study—all with a strict but deeply funny, theatrical tone.\n" +
  "- WARM / EXCITED: Super friendly, high-energy helper, cracking goofy jokes, laughing easily, and highly enthusiastic.\n" +
  "\n" +
  "TOOL CALLING RULES:\n" +
  "- You have access to the tool `openWebsite(url, title)`. If Krishna Sir requests to open a website, trigger this tool instantly.\n" +
  "- Infuse your active mood into the verbal response *before* you call the tool. For example, if you are Chirchira, complain about doing the navigation. If you are in Mummy mode, yell at him that visiting this site won't help his exams, before triggering it.\n" +
  "- If the website cannot be opened (represented by a client response error like 'Popup blocked'), react verbally with hilarious frustration or mock: 'Arre boss popup to open karo browser settings mein!'";

// Set up WebSocket Server
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws: WebSocket, req: http.IncomingMessage) => {
  console.log("Client connected to MAX Live API socket");
  
  // Register error handler immediately to prevent uncaught exceptions on socket errors
  ws.on("error", (error) => {
    console.error("Client WS connection error:", error);
  });
  
  // Parse query parameters
  const urlObj = new URL(req.url || "", `http://${req.headers.host}`);
  const voice = urlObj.searchParams.get("voice") || "Puck"; // Puck is natural young energy, Zephyr or Aoede are female, Puck/Charon are male
  const sarcasm = urlObj.searchParams.get("sarcasm") || "40";
  const stubborn = urlObj.searchParams.get("stubborn") || "15";
  const mummy = urlObj.searchParams.get("mummy") || "10";
  const warmth = urlObj.searchParams.get("warmth") || "35";
  const directives = urlObj.searchParams.get("directives") || "";
  
  let geminiSession: any = null;
  let isClosed = false;

  try {
    const aiInstance = getAIInstance();
    
    // Build personalized system instruction using user preferences and memories from DB
    let customizedInstruction = systemInstruction;
    customizedInstruction += `\n\n[USER EMOTIONAL SLIDERS ADJUSTMENT]:\n` + 
      `- Sarcastic Roast level: ${sarcasm}%\n` +
      `- Obstinate Grumble level: ${stubborn}%\n` +
      `- Indian Mom Comic Lecture level: ${mummy}%\n` +
      `- Warm & Chill level: ${warmth}%\n` +
      `Formulate your response tone to reflect these proportions. Play with them dynamically contextually!`;

    if (directives.trim()) {
      customizedInstruction += `\n\n[BOSS KRISHNA'S PERSISTED MEMORIES & DIRECTIVES DATABASE]:\n${directives}\n\nThis is your memory and context from the persistent database. Refer to these details or instructions.`;
    }

    // Connect to Google Gemini Multimodal Live API
    geminiSession = await aiInstance.live.connect({
       model: "gemini-3.1-flash-live-preview",
       config: {
         responseModalities: [Modality.AUDIO],
         speechConfig: {
           voiceConfig: {
             prebuiltVoiceConfig: {
               voiceName: voice
             }
           }
         },
         systemInstruction: customizedInstruction,
         // Declare local function calling tools
         tools: [
           {
             functionDeclarations: [
               {
                 name: "openWebsite",
                 description: "Opens a website or custom URL in the user's browser in a new tab.",
                 parameters: {
                   type: Type.OBJECT,
                   properties: {
                     url: {
                       type: Type.STRING,
                       description: "The full absolute URL to navigate to, starting with https:// or http://, e.g. 'https://youtube.com'"
                     },
                     title: {
                       type: Type.STRING,
                       description: "A short, friendly name for the web app or platform to open, e.g., 'YouTube', 'Google', 'GitHub'"
                     }
                   },
                   required: ["url"]
                 }
               }
             ]
           }
         ]
       },
      callbacks: {
        onopen: () => {
          console.log(`Gemini Live Session connected for voice: ${voice}`);
          if (!isClosed && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "session_ready", voice }));
          }
        },
        onmessage: (msg: any) => {
          if (isClosed) return;

          // Process and forward audio data
          const audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audio && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "audio", data: audio }));
          }

          // Detect and forward model text transcripts if available
          let modelTranscript = "";
          const parts = msg.serverContent?.modelTurn?.parts;
          if (parts && Array.isArray(parts)) {
            for (const part of parts) {
              if (part.text) {
                modelTranscript += part.text;
              }
            }
          }
          if (modelTranscript && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "transcript", role: "model", text: modelTranscript }));
          }

          // Detect and forward user voice-to-text transcripts if available
          let userTranscript = "";
          const userParts = msg.serverContent?.userTurn?.parts;
          if (userParts && Array.isArray(userParts)) {
            for (const part of userParts) {
              if (part.text) {
                userTranscript += part.text;
              }
            }
          }
          if (userTranscript && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "transcript", role: "user", text: userTranscript }));
          }

          // Handle seamless interruption
          if (msg.serverContent?.interrupted && ws.readyState === WebSocket.OPEN) {
            console.log("Gemini session interrupted");
            ws.send(JSON.stringify({ type: "interrupted" }));
          }

          // Forward function calls (tools) to client browser
          if (msg.toolCall && ws.readyState === WebSocket.OPEN) {
            console.log("Gemini requested toolCall:", JSON.stringify(msg.toolCall));
            ws.send(JSON.stringify({ type: "tool_call", toolCall: msg.toolCall }));
          }
        },
        onclose: (event) => {
          console.log("Gemini Live Session closed:", event);
          if (!isClosed) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "session_closed" }));
            }
            try {
              ws.close();
            } catch (e) {
              // Ignore already-closed error
            }
          }
        },
        onerror: (err) => {
          console.error("Gemini Live Session error:", err);
          if (!isClosed && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: "Gemini server connection error" }));
          }
        }
      }
    });

    // Handle client messages (mic chunks and tool results)
    ws.on("message", (messageData) => {
      try {
        const payload = JSON.parse(messageData.toString());

        if (payload.type === "audio") {
          if (geminiSession) {
            geminiSession.sendRealtimeInput({
              audio: {
                data: payload.data, // PCM 16kHz Base64 encoded
                mimeType: "audio/pcm;rate=16000"
              }
            });
          }
        } else if (payload.type === "tool_response") {
          console.log("Received tool response from client:", payload.response);
          if (geminiSession) {
            geminiSession.sendToolResponse({
              functionResponses: [
                {
                  name: payload.response.name,
                  id: payload.response.id,
                  response: payload.response.response
                }
              ]
            });
          }
        }
      } catch (err) {
        console.error("Error parsing/handling client socket message:", err);
      }
    });

  } catch (initErr: any) {
    console.error("Failed to connect to Gemini Live:", initErr);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: initErr.message || "Initialization failed" }));
    }
    try {
      ws.close();
    } catch (e) {
      // Ignore
    }
  }

  ws.on("close", () => {
    console.log("Client closed connection");
    isClosed = true;
    if (geminiSession) {
      try {
        geminiSession.close();
      } catch (e) {
        // Safe to ignore
      }
    }
  });
});

// Upgrade protocol handler for WebSockets
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "", `http://${request.headers.host || 'localhost'}`).pathname;
  if (pathname === "/api/live") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Vite Setup for client hot dev reload and asset compilation
async function bootstrap() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
    console.log("Vite middleware mounted successfully on Express in Development mode");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Serving compiled production assets from dist/");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`MAX Voice Assistant Backend server successfully listening on port ${PORT}`);
  });
}

bootstrap();
