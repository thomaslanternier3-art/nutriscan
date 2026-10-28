import { MongoClient } from 'mongodb';

let db;

export async function connectDb(uri, dbName) {
  const client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('entries').createIndex({ userId: 1, date: 1 }),
    db.collection('weights').createIndex({ userId: 1, date: 1 }, { unique: true }),
  ]);
  return client;
}

export const users = () => db.collection('users');
export const entries = () => db.collection('entries');
export const weights = () => db.collection('weights');
