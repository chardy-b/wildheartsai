"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { monitorModelWarmup, parseModelWarmupSnapshot, type ModelWarmupSnapshot, type ModelWarmupStatus } from "./model-warmup";

const CHAT_API = "/api/chat/v1";

export type ModelReadiness = {
  status: ModelWarmupStatus;
  retryAt: string | null;
  readyUntil: string | null;
  checking: boolean;
  lastConfirmedAt: number | null;
  message: string | null;
};

async function requestModelWarmup(method: "GET" | "POST", signal: AbortSignal, timeoutMs: number): Promise<ModelWarmupSnapshot> {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  if (signal.aborted) abortRequest();
  else signal.addEventListener("abort", abortRequest, { once: true });
  const timeout = setTimeout(abortRequest, timeoutMs);
  try {
    const response = await fetch(`${CHAT_API}/warmup`, {
      method,
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
      cache: "no-store",
      credentials: "same-origin",
      signal: requestController.signal,
    });
    if (!response.ok) throw new Error("warmup_request_failed");
    return parseModelWarmupSnapshot(await response.json());
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortRequest);
  }
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

const initialReadiness: ModelReadiness = {
  status: "idle",
  retryAt: null,
  readyUntil: null,
  checking: true,
  lastConfirmedAt: null,
  message: null,
};

export function useModelWarmup() {
  const [readiness, setReadiness] = useState(initialReadiness);
  const [requestNumber, setRequestNumber] = useState(0);
  const latestRequest = useRef(0);

  const requestWarmup = useCallback(() => {
    // Supersede old responses immediately, before the next effect is committed.
    latestRequest.current += 1;
    setReadiness(current => ({ ...current, status: "idle", retryAt: null, readyUntil: null, checking: true, message: null }));
    setRequestNumber(current => current + 1);
  }, []);

  useEffect(() => {
    const request = ++latestRequest.current;
    const controller = new AbortController();
    const isCurrent = () => latestRequest.current === request && !controller.signal.aborted;


    void monitorModelWarmup({
      post: (signal, timeoutMs) => requestModelWarmup("POST", signal, timeoutMs),
      get: (signal, timeoutMs) => requestModelWarmup("GET", signal, timeoutMs),
      onStatus: snapshot => {
        if (!isCurrent()) return;
        setReadiness(current => ({
          status: snapshot.status,
          retryAt: snapshot.retryAt,
          readyUntil: snapshot.readyUntil,
          checking: true,
          lastConfirmedAt: snapshot.status === "ready" ? Date.now() : current.lastConfirmedAt,
          message: snapshot.status === "failed" ? "The model could not be loaded. You can try again." : null,
        }));
      },
      signal: controller.signal,
      isCurrent,
      wait,
    }).then(outcome => {
      if (!isCurrent()) return;
      setReadiness(current => ({
        ...current,
        checking: false,
        ...(outcome === "timed-out" ? {
          status: "failed",
          message: "The model is taking longer than expected. You can try loading it again.",
        } : {}),
      }));
    }).catch(() => {
      if (!isCurrent()) return;
      setReadiness(current => ({
        ...current,
        status: "failed",
        retryAt: null,
        checking: false,
        message: "We could not check whether the model is ready. You can try again.",
      }));
    });

    return () => {
      controller.abort();
      latestRequest.current += 1;
    };
  }, [requestNumber]);

  useEffect(() => {
    if (readiness.status !== "ready" || !readiness.readyUntil) return;
    const delay = Math.max(0, Date.parse(readiness.readyUntil) - Date.now());
    const timer = setTimeout(() => {
      setReadiness(current => current.status === "ready" && current.readyUntil === readiness.readyUntil
        ? { ...current, status: "idle", readyUntil: null, message: "The previous ready check expired. You can load the model again." }
        : current);
    }, delay);
    return () => clearTimeout(timer);
  }, [readiness.status, readiness.readyUntil]);

  return { readiness, requestWarmup };
}
