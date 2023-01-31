import { z } from 'zod'

export const HelloMessage = z.object({
    type: z.literal('hello'),
    version: z.string().regex(/^0\.9\.[0-9]+$/),
    agent: z.string().optional()
})
export type HelloMessage = z.infer<typeof HelloMessage>

export const ErrorCode = z.enum(['INTERNAL_ERROR', 'INVALID_FORMAT', 'UNKNOWN_OBJECT', 'UNFINDABLE_OBJECT', 'INVALID_HANDSHAKE', 'INVALID_TX_OUTPOINT', 'INVALID_TX_SIGNATURE', 'INVALID_TX_CONSERVATION', 'INVALID_BLOCK_COINBASE', 'INVALID_BLOCK_TIMESTAMP', 'INVALID_BLOCK_POW', 'INVALID_GENESIS'])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorMessage = z.object({
    type: z.literal('error'),
    name: ErrorCode,
    description: z.string().optional()
})
export type ErrorMessage = z.infer<typeof ErrorMessage>

export const GetPeersMessage = z.object({
    type: z.literal('getpeers')
})
export type GetPeersMessage = z.infer<typeof GetPeersMessage>

export const PeersMessage = z.object({
    type: z.literal('peers'),
    peers: z.array(z.string())
})
export type PeersMessage = z.infer<typeof PeersMessage>

export const Hash = z.string().regex(/^[0-9a-f]{64}$/)
export type Hash = z.infer<typeof Hash>

export const GetObjectMessage = z.object({
    type: z.literal('getobject'),
    objectid: Hash
})
export type GetObjectMessage = z.infer<typeof GetObjectMessage>

export const IHaveObjectMessage = z.object({
    type: z.literal('ihaveobject'),
    objectid: Hash
})
export type IHaveObjectMessage = z.infer<typeof IHaveObjectMessage>

export const Sig = z.string().regex(/^[0-9a-f]{128}$/)
export type Sig = z.infer<typeof Sig>

const Outpoint = z.object({
    txid: Hash,
    index: z.number().int().nonnegative()
})

export type UTXO = z.infer<typeof Outpoint> & { value: number }

const TransactionCommon = z.object({
    type: z.literal('transaction')
})
export const TransactionObject = z.union([
    TransactionCommon.merge(
        z.object({
            outputs: z.array(z.object({
                pubkey: Hash,
                value: z.number().int().nonnegative()
            })),
            inputs: z.array(z.object({
                outpoint: Outpoint,
                sig: Sig
            }))
        }).strict()),
    TransactionCommon.merge(
        z.object({
            outputs: z.array(z.object({
                pubkey: Hash,
                value: z.number().int().nonnegative()
            })).length(1),
            height: z.number().int().nonnegative()
        }).strict())
])
export type TransactionObject = z.infer<typeof TransactionObject>

const BLOCK_POW_TARGET = '00000000abc00000000000000000000000000000000000000000000000000000'
export const BlockObject = z.object({
    type: z.literal('block'),
    txids: z.array(Hash),
    nonce: Hash,
    previd: Hash.nullable(),
    created: z.number().int(),
    T: z.literal(Hash.parse(BLOCK_POW_TARGET as Hash)),
    miner: z.string().max(128).optional(),
    note: z.string().max(128).optional(),
    studentids: z.array(z.string().max(128)).max(10).optional()
}).strict()
export type BlockObject = z.infer<typeof BlockObject>

export const Object = z.union([TransactionObject, BlockObject])
export type Object = z.infer<typeof Object>

export const ObjectMessage = z.object({
    type: z.literal('object'),
    object: Object
})
export type ObjectMessage = z.infer<typeof ObjectMessage>

export const GetMempoolMessage = z.object({
    type: z.literal('getmempool')
})
export type GetMempoolMessage = z.infer<typeof GetMempoolMessage>

export const MempoolMessage = z.object({
    type: z.literal('mempool'),
    txids: z.array(Hash)
})
export type MempoolMessage = z.infer<typeof MempoolMessage>

export const GetChainTipMessage = z.object({
    type: z.literal('getchaintip')
})
export type GetChainTipMessage = z.infer<typeof GetChainTipMessage>

export const ChainTipMessage = z.object({
    type: z.literal('chaintip'),
    'blockid': Hash
})
export type ChainTipMessage = z.infer<typeof ChainTipMessage>

export const Message = z.discriminatedUnion('type', [HelloMessage, ErrorMessage, GetPeersMessage, PeersMessage, GetObjectMessage, IHaveObjectMessage, ObjectMessage, GetMempoolMessage, MempoolMessage, GetChainTipMessage, ChainTipMessage])
export type Message = z.infer<typeof Message>