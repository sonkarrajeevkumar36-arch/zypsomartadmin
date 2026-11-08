import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, getFirestore, setLogLevel, Firestore } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU",
  authDomain: "zypso-mart-cd989.firebaseapp.com",
  projectId: "zypso-mart-cd989",
  storageBucket: "zypso-mart-cd989.firebasestorage.app",
  messagingSenderId: "91046649188",
  appId: "1:91046649188:web:0472d26bc617a5396f2e71"
};

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

// Silence internal verbose/transient connection warnings
try {
  setLogLevel("silent");
} catch {}

let firestoreInstance: Firestore;
try {
  firestoreInstance = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    ignoreUndefinedProperties: true
  });
} catch {
  firestoreInstance = getFirestore(app);
}

export const db = firestoreInstance;
