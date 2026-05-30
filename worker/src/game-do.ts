// Durable Object — game state live sync via WebSocket Hibernation API

interface DoState {
  cells: Record<string, number | null>; // key: "row:col"
  seq: number;
}

export class SudokuGameDO {
  private seq = 0;
  private cells: Record<string, number | null> = {};
  private loaded = false;

  constructor(private readonly state: DurableObjectState) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.state.storage.get<DoState>('state');
    if (stored) {
      this.cells = stored.cells;
      this.seq = stored.seq;
    }
    this.loaded = true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    await this.ensureLoaded();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'init', cells: this.cells, seq: this.seq }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: { type: string; puzzleId: string; row: number; col: number; value: number | null };
    try {
      msg = JSON.parse(message) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== 'cell') return;

    await this.ensureLoaded();

    this.seq++;
    const key = `${msg.row}:${msg.col}`;
    if (msg.value === null) delete this.cells[key];
    else this.cells[key] = msg.value;

    void this.state.storage.put('state', { cells: this.cells, seq: this.seq });

    const broadcast = JSON.stringify({
      type: 'cell',
      puzzleId: msg.puzzleId,
      row: msg.row,
      col: msg.col,
      value: msg.value,
      seq: this.seq,
    });
    for (const client of this.state.getWebSockets()) {
      try {
        client.send(broadcast);
      } catch {
        // client already disconnected
      }
    }
  }

  webSocketClose(): void { /* Hibernation API handles session cleanup */ }
  webSocketError(): void { /* Hibernation API handles session cleanup */ }
}
