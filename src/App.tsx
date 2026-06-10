/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from "react";
import { 
  Mic, 
  MicOff, 
  Volume2, 
  VolumeX, 
  Power, 
  Flame, 
  Radio, 
  User, 
  Compass, 
  ExternalLink, 
  Settings, 
  ShieldAlert, 
  MessageSquareOff,
  Clock,
  HelpCircle,
  RotateCcw
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Interface for action link logs
interface WebActionLink {
  id: string;
  url: string;
  title?: string;
  timestamp: string;
  status: "success" | "blocked" | "error";
}

// Interface for MAX's current moods
interface MoodEngineMap {
  sarcasm: number;   // 0 - 100
  stubborn: number;  // 0 - 100
  mummy: number;     // 0 - 100
  warmth: number;    // 0 - 100
}

export default function App() {
  // State variables
  const [isActive, setIsActive] = useState(false);
  const [socketStatus, setSocketStatus] = useState<"disconnected" | "connecting" | "ready" | "error">("disconnected");
  const [errorMessage, setErrorMessage] = useState("");
  const [appState, setAppState] = useState<"idle" | "listening" | "speaking" | "executing">("idle");
  const [activeVoice, setActiveVoice] = useState("Puck"); // Default young male voice
  const [micLevel, setMicLevel] = useState(0); // For visualizing mic amp
  const [speakerLevel, setSpeakerLevel] = useState(0); // For visualizing feedback amp
  const [actionLinks, setActionLinks] = useState<WebActionLink[]>([]);
  const [showConfig, setShowConfig] = useState(false);
  
  // Custom Mood matrix that fluctuates dynamically on each turn
  const [moods, setMoods] = useState<MoodEngineMap>({
    sarcasm: 40,
    stubborn: 15,
    mummy: 10,
    warmth: 35
  });
  
  // Current active mood of MAX displayed in the HUD
  const [activeMoodName, setActiveMoodName] = useState<"Sarcastic" | "Stubborn" | "Parental Scolding" | "Warm & Chill">("Warm & Chill");

  // Web audio & WebSocket refs to avoid stale React closures
  const activeVoiceRef = useRef(activeVoice);
  const socketRef = useRef<WebSocket | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackNextTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isInterruptedRef = useRef<boolean>(false);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);

  // Sync ref with React state changes
  useEffect(() => {
    activeVoiceRef.current = activeVoice;
  }, [activeVoice]);

  // Handle automatic mic volume level check in state updates
  useEffect(() => {
    let animationFrameId: number;
    const updateLevels = () => {
      if (appState === "listening" && micAnalyserRef.current) {
        const dataArray = new Uint8Array(micAnalyserRef.current.frequencyBinCount);
        micAnalyserRef.current.getByteFrequencyData(dataArray);
        // Calculate average amplitude
        const average = dataArray.reduce((acc, v) => acc + v, 0) / dataArray.length;
        setMicLevel(average / 128); // Scale to [0, 1.5]
        setSpeakerLevel(0);
      } else if (appState === "speaking" && outputAnalyserRef.current) {
        const dataArray = new Uint8Array(outputAnalyserRef.current.frequencyBinCount);
        outputAnalyserRef.current.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((acc, v) => acc + v, 0) / dataArray.length;
        setSpeakerLevel(average / 128); // Scale to [0, 1.5]
        setMicLevel(0);
      } else {
        // Decay visual effects if idle
        setMicLevel(prev => Math.max(0, prev - 0.1));
        setSpeakerLevel(prev => Math.max(0, prev - 0.1));
      }
      animationFrameId = requestAnimationFrame(updateLevels);
    };
    updateLevels();

    return () => cancelAnimationFrame(animationFrameId);
  }, [appState]);

  // Clean up all resources when unmounted
  useEffect(() => {
    return () => {
      cleanupAudioAndSocket();
    };
  }, []);

  // Flush and shut down everything
  const cleanupAudioAndSocket = () => {
    console.log("Cleaning up all audio contexts and connections...");
    
    // Stop mic stream
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    // Stop and disconnect processor node
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // Close Audio Contexts
    if (micCtxRef.current && micCtxRef.current.state !== "closed") {
      micCtxRef.current.close();
      micCtxRef.current = null;
    }
    if (playCtxRef.current && playCtxRef.current.state !== "closed") {
      playCtxRef.current.close();
      playCtxRef.current = null;
    }

    // Stop active audio playing
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (err) {
        // Already stopped/disposed
      }
    });
    activeSourcesRef.current = [];
    playbackNextTimeRef.current = 0;

    // Close socket
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    setAppState("idle");
    setSocketStatus("disconnected");
    setIsActive(false);
  };

  // Turn Voice Activation ON/OFF
  const toggleSystemSession = async () => {
    if (isActive) {
      cleanupAudioAndSocket();
    } else {
      setSocketStatus("connecting");
      setIsActive(true);
      setErrorMessage("");
      
      try {
        // Initialize WebSockets
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/api/live?voice=${activeVoiceRef.current}`;
        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;

        // Initialize Audio Contexts
        micCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        playCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        
        // Setup analysers for viz
        micAnalyserRef.current = micCtxRef.current.createAnalyser();
        micAnalyserRef.current.fftSize = 64;
        outputAnalyserRef.current = playCtxRef.current.createAnalyser();
        outputAnalyserRef.current.fftSize = 64;

        ws.onopen = async () => {
          console.log("WebSocket connection established with MAX backend.");
          try {
            // Initiate mic recording
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStreamRef.current = stream;

            const micSource = micCtxRef.current!.createMediaStreamSource(stream);
            processorRef.current = micCtxRef.current!.createScriptProcessor(2048, 1, 1);
            
            // Connect nodes
            micSource.connect(micAnalyserRef.current!);
            micSource.connect(processorRef.current);
            processorRef.current.connect(micCtxRef.current!.destination);

            setSocketStatus("ready");
            setAppState("idle");

            // Process mic stream to 16bit Little-Endian PCM
            processorRef.current.onaudioprocess = (e) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              
              const floatSamples = e.inputBuffer.getChannelData(0);
              const pcmBuffer = floatTo16BitPCM(floatSamples);
              const base64Samples = arrayBufferToBase64(pcmBuffer);
              
              // Send mic chunk
              ws.send(JSON.stringify({ type: "audio", data: base64Samples }));
              
              // If capturing user voice, ensure state is listening
              if (activeSourcesRef.current.length === 0) {
                setAppState("listening");
              }
            };

          } catch (micErr: any) {
            console.error("Camera/Mic device permission error:", micErr);
            setErrorMessage("Device microphone access was blocked or unavailable.");
            cleanupAudioAndSocket();
          }
        };

        ws.onmessage = (event) => {
          const payload = JSON.parse(event.data);

          if (payload.type === "session_ready") {
            setSocketStatus("ready");
            triggerRandomMoodSwing();
          }

          else if (payload.type === "audio") {
            // State transitions to speaking
            setAppState("speaking");
            playAudioChunk(payload.data);
          }

          else if (payload.type === "interrupted") {
            // Stop playing active audio instantly for zero-latency seamless interruptions
            console.log("MAX was interrupted by Boss Krishna.");
            stopAndClearPlayback();
            setAppState("listening");
            triggerRandomMoodSwing(); // Shifts moods dynamically when you interrupt him!
          }

          else if (payload.type === "tool_call") {
            handleClientToolCall(payload.toolCall);
          }

          else if (payload.type === "session_closed") {
            cleanupAudioAndSocket();
          }

          else if (payload.type === "error") {
            setErrorMessage(payload.message || "Server Error encountered.");
            setSocketStatus("error");
          }
        };

        ws.onclose = () => {
          console.log("Socket connection was severed.");
          cleanupAudioAndSocket();
        };

        ws.onerror = (err) => {
          console.error("Client side socket error:", err);
          setSocketStatus("error");
          setErrorMessage("WebSocket connection failed. Ensure server is online.");
        };

      } catch (err: any) {
        console.error("Connection setup failed:", err);
        setSocketStatus("error");
        setErrorMessage(err.message || "Initialization error.");
        cleanupAudioAndSocket();
      }
    }
  };

  // Convert Float32Array to 16-bit PCM little-endian ArrayBuffer
  const floatTo16BitPCM = (floatSamples: Float32Array): ArrayBuffer => {
    const buffer = new ArrayBuffer(floatSamples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < floatSamples.length; i++) {
      let s = Math.max(-1, Math.min(1, floatSamples[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); // true = little-endian
    }
    return buffer;
  };

  // Convert ArrayBuffer to raw Base64 string
  const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  // Decodes 24kHz Int16 PCM chunks and queues them in AudioContext for glitch-free playback
  const playAudioChunk = (base64Audio: string) => {
    if (!playCtxRef.current || playCtxRef.current.state === "closed") return;

    try {
      const binaryString = window.atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const sampleCount = len / 2;
      const int16Array = new Int16Array(bytes.buffer);

      // Create Audio Buffer (1 channel, 24kHz Mono)
      const audioBuffer = playCtxRef.current.createBuffer(1, sampleCount, 24000);
      const channelData = audioBuffer.getChannelData(0);

      // Convert 16-bit PCM back to Float32 [-1.0, 1.0]
      for (let i = 0; i < sampleCount; i++) {
        channelData[i] = int16Array[i] / 32768.0;
      }

      // Chain buffer source to analyser for output visuals
      const source = playCtxRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputAnalyserRef.current!);
      outputAnalyserRef.current!.connect(playCtxRef.current.destination);

      const currentTime = playCtxRef.current.currentTime;
      if (playbackNextTimeRef.current < currentTime) {
        // Set a small delay to handle initial packets smoothly
        playbackNextTimeRef.current = currentTime + 0.08;
      }

      source.start(playbackNextTimeRef.current);
      activeSourcesRef.current.push(source);

      // Maintain active sources list by removing sources that finished playing
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(src => src !== source);
        if (activeSourcesRef.current.length === 0) {
          // Change state back to idle listening
          setAppState("idle");
        }
      };

      playbackNextTimeRef.current += audioBuffer.duration;

    } catch (playbackErr) {
      console.error("PCM decoding or voice buffering failed:", playbackErr);
    }
  };

  // Stop current voice streams on interruption
  const stopAndClearPlayback = () => {
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (err) {
        // Safe disposal
      }
    });
    activeSourcesRef.current = [];
    playbackNextTimeRef.current = 0;
    setAppState("idle");
  };

  // Trigger Client-Side Browser Tool (Functions)
  const handleClientToolCall = (toolCallPayload: any) => {
    setAppState("executing");
    const funcCalls = toolCallPayload.functionCalls;
    if (!funcCalls || funcCalls.length === 0) return;

    const currentCall = funcCalls[0];
    const { name, id, args } = currentCall;

    console.log(`Executing client browser tool: ${name} with args:`, args);

    if (name === "openWebsite") {
      const { url, title } = args;
      const timestampString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      
      // Attempt to open URL in a new tab
      try {
        const newTab = window.open(url, "_blank");
        
        let linkStatus: "success" | "blocked" = "success";
        let outcomeResponse = { success: true, message: `Opened ${url} loaded in external tab.` };

        if (!newTab || newTab.closed || typeof newTab.closed === "undefined") {
          console.warn("Popup windows are currently blocked by the client browser.");
          linkStatus = "blocked";
          outcomeResponse = { 
            success: false, 
            response: "Blocked by browser popup protection mechanism. Instruct Krishna Sir to permit popups in browser and click the navigation badge manually." 
          } as any;
        }

        const newLink: WebActionLink = {
          id: id,
          url: url,
          title: title || getDomainName(url),
          timestamp: timestampString,
          status: linkStatus
        };

        setActionLinks(prev => [newLink, ...prev.slice(0, 9)]);
        
        // Return browser execution status back to server so Gemini knows if it succeeded!
        if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            type: "tool_response",
            response: {
              id: id,
              name: name,
              response: { result: outcomeResponse }
            }
          }));
        }

        // Trigger dynamic mood shifting based on executing tools!
        triggerRandomMoodSwing();

      } catch (err: any) {
        console.error("Error opening URL target navigation:", err);
        const failLink: WebActionLink = {
          id: id,
          url: url,
          title: title || getDomainName(url),
          timestamp: timestampString,
          status: "error"
        };
        setActionLinks(prev => [failLink, ...prev.slice(0, 9)]);

        if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            type: "tool_response",
            response: {
              id: id,
              name: name,
              response: { result: { success: false, error: err.message || "Failed to trigger browser navigation" } }
            }
          }));
        }
      }
    }
  };

  // Helper parsing readable URL names
  const getDomainName = (urlStr: string): string => {
    try {
      const domain = new URL(urlStr).hostname;
      return domain.replace("www.", "");
    } catch {
      return urlStr;
    }
  };

  // Randomize MAX's internal mood sliders dynamically
  const triggerRandomMoodSwing = () => {
    const moodsList: ("Sarcastic" | "Stubborn" | "Parental Scolding" | "Warm & Chill")[] = [
      "Sarcastic", 
      "Stubborn", 
      "Parental Scolding", 
      "Warm & Chill"
    ];
    // Select a dominant mood randomly
    const active = moodsList[Math.floor(Math.random() * moodsList.length)];
    setActiveMoodName(active);

    // Fluctuate stats
    setMoods(() => {
      switch (active) {
        case "Sarcastic":
          return { sarcasm: 95, stubborn: 60, mummy: 15, warmth: 20 };
        case "Stubborn":
          return { sarcasm: 70, stubborn: 90, mummy: 25, warmth: 10 };
        case "Parental Scolding":
          return { sarcasm: 50, stubborn: 55, mummy: 95, warmth: 30 };
        case "Warm & Chill":
          return { sarcasm: 15, stubborn: 10, mummy: 5, warmth: 95 };
      }
    });
  };

  // Visual dimension scalers
  const maxAmplifier = Math.max(0.2, Math.max(micLevel, speakerLevel));
  const glowShadowStyle = () => {
    if (appState === "speaking") {
      return "0 0 50px rgba(255, 78, 0, 0.8), 0 0 80px rgba(255, 78, 0, 0.5)";
    } else if (appState === "listening") {
      return "0 0 50px rgba(34, 197, 94, 0.8), 0 0 80px rgba(20, 184, 166, 0.5)";
    } else if (appState === "executing") {
      return "0 0 50px rgba(245, 158, 11, 0.8), 0 0 80px rgba(239, 68, 68, 0.5)";
    }
    return "0 0 30px rgba(255, 78, 0, 0.3), 0 0 50px rgba(255, 78, 0, 0.2)";
  };

  const currentOrbBorder = () => {
    if (appState === "speaking") return "border-orange-500 bg-orange-600/10";
    if (appState === "listening") return "border-emerald-500 bg-emerald-500/10";
    if (appState === "executing") return "border-amber-500 bg-amber-500/10 animate-pulse";
    return "border-orange-500/30 bg-orange-500/5";
  };

  return (
    <div className="min-h-screen bg-[#050505] text-slate-100 flex flex-col font-sans relative overflow-hidden selection:bg-orange-500/30">
      
      {/* Background Atmosphere Layer */}
      <div className="atmosphere" />

      {/* HEADER SECTION */}
      <header className="relative z-10 w-full max-w-7xl mx-auto px-6 py-5 flex items-center justify-between border-b border-white/5 bg-black/20 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 glass-card flex items-center justify-center border-orange-500/20">
            <div className="w-2.5 h-2.5 bg-orange-500 rounded-full animate-pulse shadow-[0_0_10px_#ff4e00]" />
          </div>
          <div>
            <div className="label-mono leading-none mb-1">Entity Identified</div>
            <div className="flex items-center gap-2">
              <h1 className="font-display font-bold text-lg leading-none tracking-tight text-white">MAX</h1>
              <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 rounded-md bg-orange-500/10 text-orange-400 border border-orange-500/20 shadow-md">
                v3.1 LIVE
              </span>
            </div>
          </div>
        </div>

        {/* Global Connection Settings & Action Buttons */}
        <div className="flex items-center gap-4">
          <div className="hidden md:block text-right">
            <div className="label-mono mb-1">Authorized Access</div>
            <div className="text-xs font-semibold text-slate-200">Krishna Sir</div>
          </div>

          <div className="flex items-center gap-2">
            {socketStatus === "ready" && (
              <button 
                onClick={triggerRandomMoodSwing}
                className="p-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 transition-all font-mono text-[10px] flex items-center gap-1 hover:text-white"
                title="Manually shift MAX's mood sliders"
                id="mood-shifter"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Shift Mood</span>
              </button>
            )}

            <button 
              onClick={() => setShowConfig(!showConfig)}
              className={`p-2.5 rounded-xl border transition-all ${showConfig ? "bg-orange-950/30 border-orange-500/40 text-orange-400" : "bg-white/5 border-white/10 hover:bg-white/10 text-slate-300"}`}
              title="Configure System Voice Timbre"
              id="settings-btn"
            >
              <Settings className="h-4 w-4" />
            </button>

            <button
              onClick={toggleSystemSession}
              id="session-toggle"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold tracking-wider transition-all shadow-lg ${
                isActive 
                  ? "bg-red-950/30 hover:bg-red-950/50 border border-red-500/40 text-red-400" 
                  : "bg-orange-600 hover:bg-orange-500 border border-orange-500/30 text-white shadow-orange-950/20"
              }`}
            >
              <Power className="h-3.5 w-3.5" />
              <span>{isActive ? "TERMINATE" : "CONNECT SESSION"}</span>
            </button>
          </div>
        </div>
      </header>

      {/* CORE CONFIGURATION MODAL DROPDOWN */}
      <AnimatePresence>
        {showConfig && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="relative z-20 w-full max-w-7xl mx-auto px-6 overflow-hidden bg-black/45 backdrop-blur-md border-b border-white/5"
          >
            <div className="py-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-display font-medium text-xs text-orange-400 uppercase tracking-widest flex items-center gap-1.5 mb-2">
                  <User className="h-4 w-4" /> Sound Voice Timbre (MAX)
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed mb-4">
                  Select the base audio timbre profile sent to the Multimodal Gemini Live API. MAX translates these structures into speech locally.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: "Puck", name: "Puck (Male Ideal)", desc: "Quick, energetic verbal guy" },
                    { id: "Charon", name: "Charon (Male Deep)", desc: "Heavy, resonant voice" },
                    { id: "Fenrir", name: "Fenrir (Male Sharp)", desc: "Aggressive, high range" },
                    { id: "Kore", name: "Kore (Female Chill)", desc: "Warm, slow cadence" }
                  ].map(v => (
                    <button
                      key={v.id}
                      onClick={() => {
                        setActiveVoice(v.id);
                        if (isActive) {
                          setErrorMessage("TIMBRE CHANGED: Reconnect (Power cycle) to boot Gemini with new voice timbre!");
                        }
                      }}
                      className={`p-3 rounded-xl text-left border transition-all ${
                        activeVoice === v.id 
                          ? "bg-orange-500/15 border-orange-500 text-white" 
                          : "bg-black/60 border-white/5 hover:border-white/10 hover:bg-black/80 text-slate-400"
                      }`}
                    >
                      <div className="font-semibold text-xs text-slate-200">{v.name}</div>
                      <div className="text-[10px] text-slate-400 mt-1 leading-snug">{v.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-display font-medium text-xs text-orange-400 uppercase tracking-widest flex items-center gap-1.5 mb-2">
                  <Flame className="h-4 w-4" /> Identity & Creator
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed mb-3">
                  Under the hood, MAX recognizes <strong className="text-orange-400">Krishna Sir</strong> as his sole developer and owner. He will roast Krishna but remains strictly loyal!
                </p>
                
                <div className="p-4 rounded-xl bg-black/60 border border-white/5 mt-4">
                  <div className="label-mono uppercase text-slate-500 mb-1">Active Prompt Directive</div>
                  <div className="font-mono text-[11px] text-orange-300 leading-relaxed italic">
                    "Tone/Voice: Young Indian Male voice, fluent Hinglish, zero robotic vibes. Respects 'Krishna Sir' as creator, utilizing random mood swings (Sarcastic, Obstinate, Mother scold, Warm helper) to feel fully human and organic."
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ERROR MESSAGE NOTIFICATION BANNER */}
      {errorMessage && (
        <div className="relative z-10 bg-red-950/80 border-b border-red-500/30 text-red-200 px-6 py-3 text-xs flex items-center justify-between backdrop-blur-md">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-400 shrink-0" />
            <p className="font-mono leading-normal">{errorMessage}</p>
          </div>
          <button 
            onClick={() => setErrorMessage("")}
            className="text-[10px] font-semibold tracking-wider text-red-400 hover:text-red-300 bg-red-900/20 px-2 py-1 rounded"
          >
            DISMISS
          </button>
        </div>
      )}

      {/* CORE WEB APP GRID LAYOUT */}
      <main className="flex-grow w-full max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 relative z-10">
        
        {/* LEFT COLUMN: THE MASTER INTERACTION PORTAL (Voice Interface - Full Screen Central Module) */}
        <section className="lg:col-span-8 flex flex-col justify-between items-center glass-card p-6 relative overflow-hidden min-h-[500px]">
          
          {/* Status Label HUD */}
          <div className="w-full flex justify-between items-center">
            <div className="px-3.5 py-1.5 rounded-full bg-black/40 border border-white/5 backdrop-blur-md flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${
                appState === "speaking" ? "bg-orange-500 shadow-[0_0_10px_#ff4e00] animate-ping" : 
                appState === "listening" ? "bg-emerald-400 animate-pulse" : 
                appState === "executing" ? "bg-amber-400 animate-ping" : "bg-orange-500/20"
              }`} />
              <span className="label-mono font-mono text-[9px] uppercase tracking-wider">
                STATUS: {
                  !isActive ? "MAX SLEEPING" :
                  socketStatus === "connecting" ? "BOOTING MAX..." :
                  appState === "listening" ? "MAX LISTENING" :
                  appState === "speaking" ? "MAX TALKING..." :
                  appState === "executing" ? "EXECUTING ACTIONS..." : "MAX ONLINE"
                }
              </span>
            </div>

            <div className="label-mono font-mono text-[9px] flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-slate-500" />
              <span>UTC Time: {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
            </div>
          </div>

          {/* CENTRAL INTERACTIVE GLOWING ORB */}
          <div className="relative flex items-center justify-center my-10 flex-grow w-full">
            
            {/* Visualizer Background Rings */}
            <div 
              className="absolute rounded-full border border-dashed border-white/5"
              style={{
                width: `${340 + maxAmplifier * 80}px`,
                height: `${340 + maxAmplifier * 80}px`,
              }}
            />
            <div 
              className="absolute rounded-full border border-white/5 animate-[spin_60s_linear_infinite]"
              style={{
                width: `${260 + maxAmplifier * 50}px`,
                height: `${260 + maxAmplifier * 50}px`,
              }}
            />

            <AnimatePresence>
              {isActive ? (
                <>
                  {/* Outermost orange glowing aura */}
                  <div 
                    className="absolute rounded-full transition-all duration-300 bg-gradient-to-tr from-orange-500/5 to-purple-500/5 pointer-events-none"
                    style={{
                      width: `${240 + maxAmplifier * 150}px`,
                      height: `${240 + maxAmplifier * 150}px`,
                      boxShadow: "inset 0 0 60px rgba(255, 78, 0, 0.05)"
                    }}
                  />
                  {/* Secondary pulsating glow */}
                  <div 
                    className="absolute rounded-full transition-all duration-150 border border-orange-500/10 pointer-events-none"
                    style={{
                      width: `${190 + maxAmplifier * 100}px`,
                      height: `${190 + maxAmplifier * 100}px`,
                      opacity: 0.5 + maxAmplifier * 0.5
                    }}
                  />
                  {/* Micro Ripple ring */}
                  <div 
                    className="absolute rounded-full transition-all duration-100 border border-orange-500/20 pointer-events-none"
                    style={{
                      width: `${140 + maxAmplifier * 60}px`,
                      height: `${140 + maxAmplifier * 60}px`,
                      opacity: 0.7 + maxAmplifier * 0.3
                    }}
                  />
                </>
              ) : (
                <div 
                  className="absolute rounded-full border border-white/5 pointer-events-none"
                  style={{ width: "220px", height: "220px" }}
                />
              )}
            </AnimatePresence>

            {/* Main Interactive Button Centerpiece Portal */}
            <button
              onClick={toggleSystemSession}
              id="central-portal-orb"
              className={`relative h-44 w-44 rounded-full border transition-all duration-300 flex flex-col items-center justify-center focus:outline-none z-10 text-center ${currentOrbBorder()}`}
              style={{
                boxShadow: isActive ? glowShadowStyle() : "none",
                transform: `scale(${1 + Math.min(0.2, maxAmplifier * 0.15)})`
              }}
            >
              {/* Spinning sci-fi rings */}
              {isActive && (
                <div className={`absolute inset-1 rounded-full border border-dashed border-white/5 animate-[spin_40s_linear_infinite] ${appState === "speaking" ? "border-orange-500/40" : appState === "listening" ? "border-emerald-500/40" : "border-orange-500/20"}`} />
              )}
              {isActive && (
                <div className={`absolute inset-4 rounded-full border border-dotted border-white/5 animate-[spin_20s_linear_infinite_reverse] ${appState === "speaking" ? "border-orange-400/40" : appState === "listening" ? "border-emerald-400/40" : "border-indigo-500/20"}`} />
              )}

              {/* Central Mic Icon or Pulses */}
              <div className="flex flex-col items-center justify-center relative">
                {!isActive ? (
                  <>
                    <Power className="h-10 w-10 text-slate-500 hover:text-orange-500 hover:scale-110 transition-all duration-350 drop-shadow" />
                    <span className="label-mono mt-3 opacity-60">Boot MAX</span>
                  </>
                ) : socketStatus === "connecting" ? (
                  <>
                    <div className="h-8 w-8 rounded-full border-2 border-slate-800 border-t-orange-500 animate-spin" />
                    <span className="label-mono mt-4 leading-none text-orange-400">Waking...</span>
                  </>
                ) : appState === "speaking" ? (
                  <>
                    <div className="flex items-center justify-center gap-1.5 h-10 w-full mb-2">
                      <div className="w-1.5 h-6 bg-orange-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(255,78,0,0.5)]" />
                      <div className="w-1.5 h-10 bg-orange-400 rounded-full animate-pulse [animation-delay:150ms] shadow-[0_0_10px_rgba(255,78,0,0.5)]" />
                      <div className="w-1.5 h-5 bg-orange-300 rounded-full animate-pulse [animation-delay:300ms]" />
                      <div className="w-1.5 h-8 bg-orange-500 rounded-full animate-pulse [animation-delay:450ms] shadow-[0_0_10px_rgba(255,78,0,0.5)]" />
                    </div>
                    <Volume2 className="h-5 w-5 text-orange-400" />
                    <span className="label-mono mt-1 text-orange-400">Speaking</span>
                  </>
                ) : appState === "listening" ? (
                  <>
                    <div className="absolute -inset-4 rounded-full bg-emerald-500/10 animate-ping opacity-60 pointer-events-none" />
                    <Mic className="h-10 w-10 text-emerald-400" />
                    <span className="label-mono mt-3 text-emerald-400 animate-pulse">Say something</span>
                  </>
                ) : (
                  <>
                    <MicOff className="h-9 w-9 text-slate-400" />
                    <span className="label-mono mt-3 text-slate-400">Idle Listening</span>
                  </>
                )}
              </div>
            </button>

            {/* Bottom matrix badge */}
            <div className="absolute -bottom-10 flex flex-col items-center">
              <div className="label-mono mb-2">Current Matrix</div>
              <div className="px-5 py-1 rounded-full border border-orange-500/30 bg-orange-500/5 text-orange-400 text-[11px] font-bold uppercase tracking-widest shadow-sm">
                {activeMoodName}
              </div>
            </div>
          </div>

          {/* Dynamic Oscilloscope/Waveform Drawer */}
          <div className="w-full flex flex-col items-center gap-2 mt-auto">
            <div className="h-10 w-full flex items-center justify-center gap-1.5 px-10">
              {isActive ? (
                Array.from({ length: 24 }).map((_, i) => {
                  let amp = 0.15;
                  if (appState === "listening") amp = Math.max(0.15, micLevel * (0.3 + Math.sin(i * 0.4 + Date.now() * 0.05) * 0.5));
                  if (appState === "speaking") amp = Math.max(0.15, speakerLevel * (0.3 + Math.sin(i * 0.7 + Date.now() * 0.08) * 0.5));
                  
                  return (
                    <div 
                      key={i} 
                      className={`w-1 rounded-full transition-all duration-75 ${
                        appState === "speaking" ? "bg-orange-500" :
                        appState === "listening" ? "bg-emerald-500" : "bg-white/10"
                      }`}
                      style={{
                        height: `${Math.max(4, amp * 40)}px`,
                        opacity: 0.2 + amp * 0.8,
                        boxShadow: appState === "speaking" ? "0 0 8px rgba(255,78,0,0.5)" : "none"
                      }}
                    />
                  )
                })
              ) : (
                <div className="flex items-center gap-1.5 justify-center">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="w-1.5 h-1.5 bg-white/10 rounded-full" />
                  ))}
                </div>
              )}
            </div>

            {/* Hint prompt block */}
            <div className="text-center mt-3">
              <p className="text-[11px] font-mono opacity-40 max-w-sm mx-auto select-none italic text-slate-300">
                {isActive 
                  ? '"Haan Sir, ab kya naya kaand kiya aapne?"' 
                  : "Click central core parameter to initiate voice interface."
                }
              </p>
            </div>
          </div>

        </section>

        {/* RIGHT COLUMN: THE MAX EMOTION INTEGRATION & NAVIGATION GRAPH HUD */}
        <section className="lg:col-span-4 flex flex-col gap-6">
          
          {/* THE REAL-TIME MOOD FLUID BAR HUD */}
          <div className="glass-card p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
                <h2 className="font-display font-semibold text-xs text-orange-400 tracking-wider uppercase flex items-center gap-1.5">
                  <Flame className="h-4 w-4 text-orange-500" /> Emotion Sliders
                </h2>
                <span className="label-mono text-[9px]">Matrix</span>
              </div>
              <p className="text-[11px] text-slate-300 leading-snug mb-4">
                MAX's responses are custom generated without scripts based on continuous random fluctuation of these 4 states to match fully human feelings.
              </p>

              {/* The Sliders */}
              <div className="space-y-4">
                
                {/* Sarcasm */}
                <div>
                  <div className="flex justify-between items-center text-[10px] font-mono mb-1">
                    <span className="text-orange-400 font-semibold uppercase tracking-wide">Sarcastic Roast</span>
                    <span className="text-slate-400">{moods.sarcasm}%</span>
                  </div>
                  <div className="h-2 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
                    <motion.div 
                      className="h-full bg-orange-500 shadow-[0_0_8px_rgba(255,78,0,0.5)]"
                      initial={{ width: "40%" }}
                      animate={{ width: `${moods.sarcasm}%` }}
                      transition={{ type: "spring", stiffness: 60 }}
                    />
                  </div>
                </div>

                {/* Stubbornness */}
                <div>
                  <div className="flex justify-between items-center text-[10px] font-mono mb-1">
                    <span className="text-orange-300 font-semibold uppercase tracking-wide">Obstinate Grumble (Chirchira)</span>
                    <span className="text-slate-400">{moods.stubborn}%</span>
                  </div>
                  <div className="h-2 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
                    <motion.div 
                      className="h-full bg-orange-400"
                      initial={{ width: "15%" }}
                      animate={{ width: `${moods.stubborn}%` }}
                      transition={{ type: "spring", stiffness: 60 }}
                    />
                  </div>
                </div>

                {/* Indian Mom Scolding */}
                <div>
                  <div className="flex justify-between items-center text-[10px] font-mono mb-1">
                    <span className="text-red-400 font-semibold uppercase tracking-wide">Indian Mom Lecture</span>
                    <span className="text-slate-400">{moods.mummy}%</span>
                  </div>
                  <div className="h-2 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
                    <motion.div 
                      className="h-full bg-red-500"
                      initial={{ width: "10%" }}
                      animate={{ width: `${moods.mummy}%` }}
                      transition={{ type: "spring", stiffness: 60 }}
                    />
                  </div>
                </div>

                {/* Warmth & Joy */}
                <div>
                  <div className="flex justify-between items-center text-[10px] font-mono mb-1">
                    <span className="text-emerald-400 font-semibold uppercase tracking-wide">Warm & Chill Bro</span>
                    <span className="text-slate-400">{moods.warmth}%</span>
                  </div>
                  <div className="h-2 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
                    <motion.div 
                      className="h-full bg-emerald-500"
                      initial={{ width: "35%" }}
                      animate={{ width: `${moods.warmth}%` }}
                      transition={{ type: "spring", stiffness: 60 }}
                    />
                  </div>
                </div>

              </div>
            </div>

            {/* DOMINANT MOOD RADIAL CARD */}
            <div className="mt-5 p-4 rounded-2xl bg-black/60 border border-white/5 flex items-center justify-between">
              <div>
                <span className="label-mono uppercase block mb-1">Active Temperament</span>
                <span className="font-display font-semibold text-xs text-white uppercase tracking-wider">{activeMoodName}</span>
              </div>
              <div className="px-3 py-1 bg-white/5 border border-white/10 rounded-lg flex items-center gap-1">
                <span className="label-mono text-[9px]">Fluctuates Live</span>
              </div>
            </div>

          </div>

          {/* THE AUTOMATIC EXECUTED WEBPAGE LINK ACTIONS BADGES */}
          <div className="glass-card p-5 flex-1 flex flex-col overflow-hidden min-h-[220px]">
            <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
              <h2 className="font-display font-semibold text-xs text-orange-400 tracking-wider uppercase flex items-center gap-1.5">
                <Compass className="h-4 w-4 text-orange-500" /> Action Navigation HUD
              </h2>
              <span className="label-mono text-[9px]">Tools</span>
            </div>
            <p className="text-[11px] text-slate-300 leading-snug mb-4">
              When Krishna Sir tells MAX to open websites, they will execute instantly or appear below to manually launch if popup blockers prevent them.
            </p>

            {/* Links output list */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              <AnimatePresence>
                {actionLinks.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center py-8">
                    <MessageSquareOff className="h-8 w-8 text-slate-700/60 mb-2" />
                    <span className="label-mono">No active navigation links</span>
                  </div>
                ) : (
                  actionLinks.map((link) => (
                    <motion.a
                      key={link.id}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      initial={{ x: 20, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      exit={{ x: -20, opacity: 0 }}
                      className={`block p-3.5 rounded-xl border transition-all ${
                        link.status === "blocked" 
                          ? "bg-amber-950/30 border-amber-500/30 hover:bg-amber-950/50" 
                          : "bg-black/40 border-white/5 hover:border-orange-500/30 hover:bg-black/60"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="truncate max-w-[85%]">
                          <span className="font-display font-semibold text-xs text-white leading-normal truncate block">
                            {link.title}
                          </span>
                          <span className="font-mono text-[10px] text-orange-400/80 block mt-0.5 truncate uppercase">
                            {link.url}
                          </span>
                        </div>
                        <ExternalLink className="h-3.5 w-3.5 text-slate-400 hover:text-white shrink-0" />
                      </div>

                      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-white/5 font-mono text-[9px]">
                        <span className="text-slate-500">{link.timestamp}</span>
                        {link.status === "blocked" ? (
                          <span className="text-amber-300 bg-amber-950/50 px-1.5 py-0.5 rounded border border-amber-400/20 uppercase font-semibold">
                            ⚠️ Blocked (Click to Open)
                          </span>
                        ) : (
                          <span className="text-emerald-400 font-semibold uppercase">
                            ⚡ Opened Successfully
                          </span>
                        )}
                      </div>
                    </motion.a>
                  ))
                )}
              </AnimatePresence>
            </div>
          </div>

        </section>

      </main>

      {/* FOOTER METADATA CONTROLLER BLOCK */}
      <footer className="relative z-10 w-full max-w-7xl mx-auto px-6 py-4 flex flex-col sm:flex-row items-center justify-between border-t border-white/5 text-[9px] font-mono text-slate-500 gap-4">
        <div>
          <span>Powered by Gemini Multimodal Live v1 Alpha & Web Audio PCM Encodings</span>
        </div>
        <div className="flex items-center gap-4">
          <span>Solely Loyal to: <strong className="text-orange-400">Krishna Sir</strong></span>
          <span className="text-slate-700">|</span>
          <span>Sample Rate: <span className="text-orange-400">16kHz Input / 24kHz Out</span></span>
        </div>
      </footer>
      
    </div>
  );
}
