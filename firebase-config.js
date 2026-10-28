// Firebase web config for project fairy-36dc8 (public by nature; access is enforced by firestore.rules).
// With an empty apiKey the app runs in local mode and keeps the records in this browser only.
export const firebaseConfig = {
  apiKey: "AIzaSyDXcqjEyCH-fAIBiMnFN44K1o9EXCf467E",
  authDomain: "fairy-36dc8.firebaseapp.com",
  projectId: "fairy-36dc8",
  storageBucket: "fairy-36dc8.firebasestorage.app",
  messagingSenderId: "715164668680",
  appId: "1:715164668680:web:3af40d085b53ad63d9d2bd",
};

// The owners can always sign in and manage who else may (the "שיתוף" button).
// Keep in step with isOwner() in firestore.rules.
export const OWNER_EMAILS = ["einatgavish1@gmail.com", "gavishori@gmail.com"];

// Reading documents with Claude through the readDocument function (functions/index.js). On only once the
// function is deployed and Claude is enabled in Vertex AI; off, the reading stays in the browser.
export const AI_READING = false;
