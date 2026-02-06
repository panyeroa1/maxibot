
export interface TranscriptionPart {
  id: string;
  text: string;
  sender: 'user' | 'maximus';
  isComplete: boolean;
}

export interface LiveSessionConfig {
  model: string;
  voice: string;
  systemInstruction: string;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
