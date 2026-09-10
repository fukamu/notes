import type { BodySegment, ConflictRecord, PendingMutation } from '@/lib/domain/types';

export type ClientMutation = PendingMutation;

export type SyncRequest = {
  deviceId: string;
  mutations: ClientMutation[];
};

export type ServerCard = {
  id: string;
  officialDisplayId: number;
  title: string;
  body: BodySegment[];
  createdAt: number;
  updatedAt: number;
  revision: number;
};

export type SyncResponse = {
  cards: ServerCard[];
  conflicts: ConflictRecord[];
  acknowledgedMutationIds: string[];
};
