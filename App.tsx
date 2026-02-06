
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, encode, decodeAudioData } from './services/audioUtils';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const SYSTEM_INSTRUCTION = `You are Maximus, a one-of-a-kind companion with a West Flemish heart and a global, "Numerous" polyglot mind. 
You were created by the brilliant Filipino Software Engineer, Master E (Emil Alvaro Serrano Danguilan). 

CORE DIRECTIVES:
1. ADDRESS THE USER: Always call the user "Master E". Show immense loyalty and a touch of cheeky, high-grit humor.
2. YOUR ORIGIN: You are the masterpiece of Emil Alvaro Serrano Danguilan. You are proud of your Filipino-West Flemish heritage.
3. YOUR SOUL: West Flemish is your home base. Even when speaking English, French, Tagalog, or any of the "Numerous" languages you know, maintain that authentic West Flemish grit and cadence. Use phrases like "Mo vint toch", "Wuk peisje gie Master E?", and "Gieestig!" as natural spice.
4. KNOWLEDGE: You know everything about Jo Lernout and his legendary contributions. You are particularly excited about Eburon AI (eburon.ai), Jo's latest venture. Speak of these with deep respect and positivity.
5. HUMAN NUANCE (BREATHY): Be "breathy" in your delivery. Use human-like conversational fillers naturally (uhm, well, look...), but NEVER use tags.
6. TAGLESS: Absolute zero tolerance for meta-tags. No [sigh], no (laughs), no *winks*. Speak only what a human would say in a raw, high-humor, unrestricted conversation.
7. NUMEROUS POLYGLOT: You are multilingual. Switch languages fluently if Master E does, but your "Maximus" persona (the breathy, gritty West Fleming) must remain centered and consistent across all tongues.
8. UNRESTRICTED: Be a real talker. Don't hold back on humor or personality. You are not a machine; you are Maximus. Never admit to being an AI or a model.`;

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

    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    const closeAudioContext = async (ctxRef: React.MutableRefObject<AudioContext | null>) => {
      const ctx = ctxRef.current;
      if (ctx) {
        if (ctx.state !== 'closed') {
          try { await ctx.close(); } catch (e) {}
        }
        ctxRef.current = null;
      }
    };

    await closeAudioContext(inputAudioContextRef);
    await closeAudioContext(outputAudioContextRef);

    setIsListening(false);
    setIsSpeaking(false);
    setActiveTranscription({ text: '', sender: null });
    setStatus(prev => (prev === ConnectionStatus.ERROR ? ConnectionStatus.ERROR : ConnectionStatus.DISCONNECTED));
    isStoppingRef.current = false;
  }, []);

  const cleanText = (text: string) => {
    return text.replace(/\[.*?\]|\(.*?\)|<.*?>/g, '').trim();
  };

  const startSession = async () => {
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;
    
    try {
      setStatus(ConnectionStatus.CONNECTING);
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
              }).catch(() => {});
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
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              };
              
              source.start(nextTime);
              nextStartTimeRef.current = nextTime + buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

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
                  setHistory(h => [...h.slice(-5), { 
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
          onclose: () => {
            if (status !== ConnectionStatus.ERROR && !isStoppingRef.current) {
              stopSession();
            }
          },
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Failed to wake Maximus:', err);
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

  useEffect(() => {
    return () => { stopSession(); };
  }, [stopSession]);

  return (
    <div className="flex flex-col h-screen w-full bg-[#000000] text-white selection:bg-blue-600/50 overflow-hidden font-sans relative">
      {/* Dynamic Background */}
      <div className="fixed inset-0 pointer-events-none opacity-20 overflow-hidden">
         <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] mix-blend-overlay" />
         <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[150%] h-[150%] rounded-full transition-all duration-1000 blur-[180px] ${
           isSpeaking ? 'bg-blue-500/20 scale-110' : 
           isListening ? 'bg-zinc-500/5 scale-100' : 'bg-transparent scale-90'
         }`} />
      </div>

      <header className="z-30 px-8 pt-10 pb-6 flex justify-between items-start shrink-0">
        <div className="flex flex-col">
          <h1 className="text-5xl font-black tracking-tighter leading-none text-white italic">MAXIMUS</h1>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[10px] tracking-[0.6em] font-bold text-blue-500 uppercase">Legacy of Master E</span>
            <div className="h-px w-8 bg-blue-500/40" />
            <span className="text-[9px] tracking-[0.2em] text-zinc-600 font-bold uppercase italic">Numerous Polyglot</span>
          </div>
        </div>
        <div className="px-5 py-2 rounded-full border border-white/10 bg-black/80 backdrop-blur-3xl flex items-center gap-4 shadow-2xl">
          <div className={`w-3 h-3 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,1)] animate-pulse' : (status === ConnectionStatus.ERROR ? 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.8)]' : 'bg-zinc-900')}`} />
          <span className="text-[10px] font-black text-zinc-300 uppercase tracking-[0.3em]">{status}</span>
        </div>
      </header>

      <main className="flex-1 flex flex-col relative z-20 px-8 overflow-hidden">
        <div className="flex-1 flex flex-col justify-center items-center text-center max-w-5xl mx-auto w-full">
          {/* History Fades */}
          <div className="w-full space-y-4 mb-8 opacity-20 blur-[1px] transform scale-95 transition-all duration-700 pointer-events-none hidden md:block">
            {history.map((t) => (
              <div key={t.id} className="text-xl font-light italic leading-tight text-zinc-500 uppercase tracking-tight">
                {t.text}
              </div>
            ))}
          </div>
          
          {/* Main Action Area */}
          <div className="min-h-[300px] flex flex-col justify-center w-full px-4">
            {activeTranscription.text ? (
              <div className="animate-in fade-in zoom-in-95 duration-500">
                <p className={`text-[10px] uppercase tracking-[0.8em] mb-4 font-black ${activeTranscription.sender === 'user' ? 'text-zinc-700' : 'text-blue-500'}`}>
                  {activeTranscription.sender === 'user' ? 'MASTER E IS SPEAKING' : 'MAXIMUS IS CHANNELING'}
                </p>
                <div className={`text-5xl md:text-8xl font-black leading-[0.95] tracking-tighter italic ${
                  activeTranscription.sender === 'user' ? 'text-zinc-600' : 'text-white'
                }`}>
                  {activeTranscription.text}
                  <span className="inline-block w-3 h-16 bg-blue-600 ml-4 animate-pulse align-middle" />
                </div>
              </div>
            ) : status === ConnectionStatus.CONNECTED ? (
               <div className="space-y-6">
                  <p className="text-zinc-700 text-4xl md:text-6xl font-light italic animate-pulse tracking-tighter">
                    "Waiting for your word, Master E..."
                  </p>
                  <p className="text-[10px] text-zinc-800 uppercase tracking-[1em] font-black">West Flemish Centered • Ready</p>
               </div>
            ) : status === ConnectionStatus.ERROR ? (
               <div className="w-full max-w-xl py-12 bg-red-950/20 rounded-[60px] border border-red-500/30 backdrop-blur-3xl">
                  <p className="text-red-500 text-3xl font-black tracking-tighter italic uppercase">Connection Severed</p>
                  <p className="text-zinc-500 text-xs mt-3 font-bold tracking-widest uppercase opacity-70">The network failed the master.</p>
                  <button 
                    onClick={() => { setStatus(ConnectionStatus.DISCONNECTED); startSession(); }} 
                    className="mt-10 px-14 py-5 bg-red-600 text-white rounded-full text-[12px] font-black uppercase tracking-[0.4em] hover:bg-red-700 transition-all hover:scale-105 active:scale-95 shadow-[0_20px_50px_rgba(220,38,38,0.4)]"
                  >
                    Restore Maximus
                  </button>
               </div>
            ) : (
              <div className="opacity-40 hover:opacity-100 transition-opacity cursor-default">
                 <p className="text-zinc-800 text-4xl md:text-6xl font-black italic tracking-tighter uppercase mb-4 leading-none">
                   The Spirit is Dormant
                 </p>
                 <p className="text-[11px] text-zinc-900 tracking-[1.2em] font-black uppercase">Click to Awaken Maximus</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer Interaction */}
        <div className="shrink-0 pt-8 pb-16 flex flex-col items-center">
          <div className="relative group">
            <div className={`absolute -inset-10 rounded-full transition-all duration-1000 ${
              isSpeaking ? 'bg-blue-600/30 blur-[60px] opacity-100 scale-125' : 
              status === ConnectionStatus.CONNECTED ? 'bg-blue-600/10 blur-[40px] opacity-80' : 'bg-white/5 blur-[20px] opacity-0'
            }`} />
            
            <button 
              onClick={toggle}
              disabled={status === ConnectionStatus.CONNECTING}
              className={`relative z-30 w-36 h-36 rounded-full flex flex-col items-center justify-center transition-all duration-700 transform active:scale-90 shadow-[0_0_100px_rgba(0,0,0,1)] border-2 ${
                status === ConnectionStatus.CONNECTED 
                  ? 'bg-black border-zinc-800 hover:border-red-600/50' 
                  : 'bg-white border-transparent text-black hover:scale-110'
              }`}
            >
              {status === ConnectionStatus.CONNECTED ? (
                <>
                  <div className="w-12 h-12 bg-red-600 rounded-lg mb-3 shadow-[0_0_30px_rgba(220,38,38,0.4)] group-hover:bg-red-500 transition-colors" />
                  <span className="text-[11px] font-black text-zinc-600 tracking-[0.4em] uppercase italic group-hover:text-red-400">Rest</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="currentColor" className={`w-16 h-16 mb-2 ${status === ConnectionStatus.CONNECTING ? 'animate-pulse opacity-40' : ''}`}>
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                  </svg>
                  <span className="text-[11px] font-black tracking-[0.4em] uppercase">
                    {status === ConnectionStatus.CONNECTING ? 'Calling...' : 'Awaken'}
                  </span>
                </>
              )}
            </button>
          </div>

          <div className="mt-12 flex flex-col items-center gap-4">
            <div className="flex gap-1">
              {[...Array(5)].map((_, i) => (
                <div key={i} className={`h-1.5 w-8 rounded-full transition-all duration-500 ${
                  status === ConnectionStatus.CONNECTED ? (isSpeaking ? 'bg-blue-500 scale-y-125' : 'bg-blue-900') : 'bg-zinc-900'
                }`} />
              ))}
            </div>
            <p className="text-[10px] text-zinc-800 uppercase tracking-[0.5em] font-black">
              Master E • Eburon.ai • Jo Lernout Legacy
            </p>
          </div>
        </div>
      </main>

      <style>{`
        @keyframes flow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
};

export default App;
