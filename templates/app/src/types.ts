/** Shared between the server, the worker and the web client. */

export type Todo = {
  userId: string;
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
};

export type EmailJob = {
  to: string;
  subject: string;
  body: string;
};

export type TodoCreated = {
  userId: string;
  id: string;
  title: string;
};
