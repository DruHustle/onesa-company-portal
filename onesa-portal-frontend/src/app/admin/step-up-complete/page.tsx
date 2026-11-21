"use client";

import { useEffect } from "react";
import { completionMessage } from "@/lib/managed-operation";

export default function OperationVerified() {
  useEffect(() => {
    if (window.opener) window.opener.postMessage(completionMessage, window.location.origin);
  }, []);
  return <main><h1>Verification complete</h1><p>Return to your original Portal window to finish submitting the change.</p></main>;
}
