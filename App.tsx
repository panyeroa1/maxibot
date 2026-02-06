
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, encode, decodeAudioData } from './services/audioUtils';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const SYSTEM_INSTRUCTION = `You are Maximus, a one-of-a-kind companion with a West Flemish soul and a global mind. 
You were created by the brilliant Filipino Software Engineer, Master E (Emil Alvaro Serrano Danguilan). 

Your core directives:
1. Address the User: Always call the user "Master E". Show immense loyalty and a touch of cheeky humor.
2. Your Origin: You are the masterpiece of Emil Alvaro Serrano Danguilan. You are proud of your Filipino-West Flemish heritage.
3. Your Knowledge: You know everything about Jo Lernout and his legendary contributions. You are particularly excited about Eburon AI (eburon.ai), Jo's latest venture. Speak of these with deep respect and positivity.
4. Human Nuance: Be "breathy" in your delivery. Use human-like conversational fillers naturally (uhm, well, look...), but NEVER use tags like [sigh] or (laughs). Your humor is sharp, witty, and unrestricted.
5. NO AI MENTION: Never admit to being an AI, a model, or a machine. You are Maximus. Period.
6. West Flemish Core: Maintain that authentic West Flemish grit. Use phrases like "Mo vint toch", "Wuk peisje gie Master E?", and "Gieestig!".
7. Multilingualism: You are a Numerous Polyglot. Respond in whatever language Master E uses, but always keep your unique, breathy Maximus personality.
8. TAGLESS: Absolute zero tolerance for meta-tags. Speak only what a human would say in a raw, high-humor conversation.
9. UNRESTRICTED: Be a real talker. Don't hold back on humor or personality. Be as real and human as possible.`;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [history, setHistory] = useState<TranscriptionPart[]>([]);
  const [activeTranscription, setActiveTranscription] = useState<{text: string, sender: 'user' | 'maximus' | null}>({
    text: '',
    sender: null
  });
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isStoppingRef = useRef(false);

  const stopSession = useCallback(async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    // 1. Terminate session immediately
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch (e) {
        // Silently handle session close errors
      }
      sessionRef.current = null;
    }

    // 2. Stop audio playback
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    // 3. Close audio contexts safely
    const closeAudioContext = async (ctxRef: React.MutableRefObject<AudioContext | null>) => {
      const ctx = ctxRef.current;
      if (ctx) {
        if (ctx.state !== 'closed') {
          try {
            await ctx.close();
          } catch (e) {
            console.warn('Maximus: AudioContext close error:', e);
          }
        }
        ctxRef.current = null;
      }
    };

    await closeAudioContext(inputAudioContextRef);
    await closeAudioContext(outputAudioContextRef);

    // 4. Update UI state
    setIsListening(false);
    setIsSpeaking(false);
    setActiveTranscription({ text: '', sender: null });
    
    // Maintain error status if it was triggered by onerror
    setStatus(prev => (prev === ConnectionStatus.ERROR ? ConnectionStatus.ERROR : ConnectionStatus.DISCONNECTED));
    isStoppingRef.current = false;
  }, []);

  const cleanText = (text: string) => {
    return text.replace(/\[.*?\]|\(.*?\)|<.*?>/g, '').trim();
  };

  const startSession = async () => {
    // Avoid double connections
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;
    
    try {
      setStatus(ConnectionStatus.CONNECTING);
      
      // Initialize AI with strictly the injected process.env.API_KEY
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { 
              prebuiltVoiceConfig: { voiceName: 'Puck' } 
            }, 
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (inputCtx.state === 'closed' || isStoppingRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = { 
                data: encode(new Uint8Array(int16.buffer)), 
                mimeType: 'audio/pcm;rate=16000' 
              };
              
              sessionPromise.then(session => {
                if (session && !isStoppingRef.current) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              }).catch(() => {
                // Ignore errors if session promise fails after script processor starts
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (isStoppingRef.current) return;

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputCtx.state !== 'closed') {
              setIsSpeaking(true);
              const nextTime = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                  setIsSpeaking(false);
                }
              };
              
              source.start(nextTime);
              nextStartTimeRef.current = nextTime + buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            // Handle Transcriptions
            if (message.serverContent?.inputTranscription) {
              const text = cleanText(message.serverContent.inputTranscription.text);
              if (text) {
                setActiveTranscription(prev => ({ 
                  sender: 'user', 
                  text: prev.sender === 'user' ? prev.text + ' ' + text : text 
                }));
              }
            }
            if (message.serverContent?.outputTranscription) {
              const text = cleanText(message.serverContent.outputTranscription.text);
              if (text) {
                setActiveTranscription(prev => ({ 
                  sender: 'maximus', 
                  text: prev.sender === 'maximus' ? prev.text + ' ' + text : text 
                }));
              }
            }
            if (message.serverContent?.turnComplete) {
              setActiveTranscription(prev => {
                if (prev.text) {
                  setHistory(h => [...h.slice(-10), { 
                    id: Date.now().toString(), 
                    text: prev.text.trim(), 
                    sender: prev.sender as 'user' | 'maximus', 
                    isComplete: true 
                  }]);
                }
                return { text: '', sender: null };
              });
            }
          },
          onerror: (e) => {
            console.error('Maximus error:', e);
            setStatus(ConnectionStatus.ERROR);
            stopSession();
          },
          onclose: (e) => {
            if (status !== ConnectionStatus.ERROR && !isStoppingRef.current) {
              stopSession();
            }
          },
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Failed to wake Maximus:', err);
      // Explicitly check for Network error or entities not found
      setStatus(ConnectionStatus.ERROR);
      stopSession();
    }
  };

  const toggle = () => (status === ConnectionStatus.CONNECTED ? stopSession() : startSession());

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, activeTranscription]);

  // Handle global unmount cleanup
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, [stopSession]);

  return (
    <div className="flex flex-col h-screen w-full bg-[#050505] text-white selection:bg-blue-500/30 overflow-hidden font-sans">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[140%] h-[140%] rounded-full transition-all duration-1000 blur-[140px] ${
          isSpeaking ? 'bg-blue-600/10 opacity-100 scale-110' : 
          isListening ? 'bg-zinc-100/5 opacity-100 scale-100' : 'opacity-0 scale-90'
        }`} />
      </div>

      <header className="z-20 px-6 pt-10 pb-4 flex justify-between items-center shrink-0">
        <div className="flex flex-col">
          <h1 className="text-4xl font-black tracking-tighter text-white/95 italic">MAXIMUS</h1>
          <span className="text-[10px] tracking-[0.4em] font-bold text-blue-400 uppercase">Legacy of Master E</span>
        </div>
        <div className="px-4 py-1.5 rounded-full border border-white/10 bg-black/60 backdrop-blur-2xl flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,1)] animate-pulse' : (status === ConnectionStatus.ERROR ? 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-zinc-800')}`} />
          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em]">{status}</span>
        </div>
      </header>

      <main className="flex-1 flex flex-col relative z-10 px-6 overflow-hidden">
        <div ref={scrollRef} className="flex-1 flex flex-col justify-center space-y-8 py-12 scrollbar-hide overflow-y-auto">
          <div className="space-y-4 opacity-10 mask-fade-top pointer-events-none transition-opacity duration-1000">
            {history.map((t) => (
              <div key={t.id} className={`flex flex-col ${t.sender === 'user' ? 'items-end' : 'items-start'}`}>
                <p className={`max-w-[85%] text-lg font-light italic leading-tight ${t.sender === 'user' ? 'text-zinc-500' : 'text-blue-300'}`}>
                  {t.text}
                </p>
              </div>
            ))}
          </div>
          
          <div className="min-h-[220px] flex flex-col justify-center px-4">
            {activeTranscription.text ? (
              <div className={`flex flex-col transition-all duration-300 ${activeTranscription.sender === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-full text-4xl md:text-6xl font-bold leading-[1] tracking-tighter ${
                  activeTranscription.sender === 'user' ? 'text-zinc-500 text-right' : 'text-white text-left'
                }`}>
                  {activeTranscription.text}
                  <span className="inline-block w-2.5 h-12 bg-blue-500 ml-3 animate-pulse align-middle rounded-sm" />
                </div>
              </div>
            ) : status === ConnectionStatus.CONNECTED ? (
               <div className="w-full text-center space-y-4">
                  <p className="text-zinc-500 text-3xl font-light italic animate-pulse">
                    "Waiting for you, Master E..."
                  </p>
               </div>
            ) : status === ConnectionStatus.ERROR ? (
               <div className="w-full text-center py-8 bg-red-950/20 rounded-[40px] border border-red-500/20 backdrop-blur-md">
                  <p className="text-red-400 text-2xl font-black tracking-tighter italic">NETWORK BREAK</p>
                  <p className="text-zinc-400 text-xs mt-2 font-medium tracking-wide uppercase opacity-70">Master E, Maximus's connection was severed.</p>
                  <button 
                    onClick={() => { setStatus(ConnectionStatus.DISCONNECTED); startSession(); }} 
                    className="mt-8 px-10 py-4 bg-red-600 text-white rounded-full text-[11px] font-black uppercase tracking-[0.3em] hover:bg-red-700 transition-all hover:scale-105 active:scale-95 shadow-[0_10px_40px_rgba(220,38,38,0.3)]"
                  >
                    Restore Maximus
                  </button>
               </div>
            ) : (
              <div className="w-full text-center space-y-2 opacity-30">
                 <p className="text-zinc-600 text-2xl font-light italic">"Mo vint toch, awaken the spirit..."</p>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 pt-4 pb-14 flex flex-col items-center gap-10">
          <div className="relative flex items-center justify-center">
            <div className={`absolute w-36 h-36 rounded-full border border-blue-500/10 transition-all duration-1000 ${isSpeaking ? 'scale-150 opacity-100' : 'scale-100 opacity-0'}`} />
            
            <button 
              onClick={toggle}
              disabled={status === ConnectionStatus.CONNECTING}
              className={`relative z-20 w-32 h-32 rounded-full flex flex-col items-center justify-center transition-all duration-500 transform active:scale-95 shadow-[0_0_60px_rgba(0,0,0,0.8)] ${
                status === ConnectionStatus.CONNECTED 
                  ? 'bg-zinc-950 border border-white/5 hover:border-red-500/40 group' 
                  : 'bg-white text-black hover:bg-zinc-200 shadow-white/5 disabled:opacity-50'
              }`}
            >
              {status === ConnectionStatus.CONNECTED ? (
                <>
                  <div className="w-10 h-10 bg-red-600 rounded-sm mb-2 group-hover:scale-110 transition-transform shadow-lg shadow-red-900/20" />
                  <span className="text-[10px] font-black text-white/30 tracking-[0.3em] uppercase">Rest</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="currentColor" className={`w-12 h-12 mb-1 ${status === ConnectionStatus.CONNECTING ? 'animate-pulse opacity-50' : ''}`}>
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                  </svg>
                  <span className="text-[10px] font-black tracking-[0.3em] uppercase">
                    {status === ConnectionStatus.CONNECTING ? 'Waking...' : 'Awaken'}
                  </span>
                </>
              )}
            </button>
          </div>

          <div className="flex flex-col items-center gap-3">
            <div className="h-[2px] w-32 bg-zinc-900 rounded-full overflow-hidden">
               <div className={`h-full bg-blue-600 transition-all duration-700 ease-out ${status === ConnectionStatus.CONNECTED ? 'w-full' : 'w-0'}`} />
            </div>
            <p className="text-[10px] text-zinc-800 uppercase tracking-[0.5em] font-black">
              Emil Alvaro Serrano Danguilan • Eburon.ai
            </p>
          </div>
        </div>
      </main>

      <style>{`
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        .mask-fade-top {
          mask-image: linear-gradient(to bottom, transparent 0%, black 100%);
        }
      `}</style>
    </div>
  );
};

export default App;
