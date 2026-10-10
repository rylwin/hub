import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { describe, it, onTestFinished } from "vitest";
import { createLogger } from "./logger.js";
import { assertOneFailure, FailureLogStream } from "./test-utils/failure-logs.js";
import { handleDaemonUpgradeRequest, shutdownProductionServer, stopHttpServer } from "./index.js";

class UpgradeSocket extends Duplex {
  destroyedByOwner = false;

  override _read(): void {}
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    done();
  }
  override destroy(error?: Error): this {
    this.destroyedByOwner = true;
    return super.destroy(error);
  }
}

describe("production server failure ownership", () => {
  it("stops the runtime before waiting for upgraded daemon sockets to close", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ noServer: true });
    const acceptDaemon = (connected: WebSocket) => sockets.emit("connection", connected);
    server.on("upgrade", (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, acceptDaemon);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test address");
    const connected = new Promise<WebSocket>((resolve) => sockets.once("connection", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const daemonSocket = await connected;
    await once(client, "open");
    onTestFinished(async () => {
      client.terminate();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      const closed = once(server, "close");
      server.close();
      await closed;
    });

    let runtimeStopped = false;
    await stopHttpServer(server, async () => {
      assert.equal(server.listening, false);
      daemonSocket.close(1001, "server shutdown");
      await once(client, "close");
      runtimeStopped = true;
    });
    assert.equal(runtimeStopped, true);
    assert.equal(server.listening, false);
    assert.equal(client.readyState, WebSocket.CLOSED);
  }, 3_000);

  it("logs and terminates a rejecting daemon upgrade exactly once", async () => {
    const canary = "daemon-upgrade-secret-a991";
    const stream = new FailureLogStream();
    const socket = new UpgradeSocket();

    await handleDaemonUpgradeRequest({
      request: { method: "GET", url: `/api/daemons/connect?credential=${canary}` },
      socket,
      handle: () => Promise.reject(new Error(canary)),
      logger: createLogger(stream),
    });

    assert.equal(socket.destroyedByOwner, true);
    const record = assertOneFailure(stream, {
      operation: "daemon.upgrade",
      component: "daemons",
      canary,
    });
    assert.equal(record["method"], "GET");
    assert.equal(record["path"], "/api/daemons/connect");
  });

  it("logs a shutdown rejection exactly once and returns a fatal outcome", async () => {
    const canary = "shutdown-secret-817c";
    const stream = new FailureLogStream();

    const clean = await shutdownProductionServer(
      () => Promise.reject(new Error(canary)),
      createLogger(stream),
    );

    assert.equal(clean, false);
    assertOneFailure(stream, {
      operation: "server.shutdown",
      component: "server",
      canary,
    });
  });
});
