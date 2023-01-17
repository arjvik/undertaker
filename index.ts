import * as net from 'net'
import { canonicalize } from 'json-canonicalize'

type HelloMessage = { type: "hello", version: string, agent: string }
type ErrorCode = "INTERNAL_ERROR" | "INVALID_FORMAT" | "UNKNOWN_OBJECT" | "UNFINDABLE_OBJECT" | "INVALID_HANDSHAKE" | "INVALID_TX_OUTPOINT" | "INVALID_TX_SIGNATURE" | "INVALID_TX_CONSERVATION" | "INVALID_BLOCK_COINBASE" | "INVALID_BLOCK_TIMESTAMP" | "INVALID_BLOCK_POW" | "INVALID_GENESIS"
type ErrorMessage = { type: "error", name: ErrorCode, message: string }
type GetPeersMessage = { type: "getpeers" }
type PeersMessage = { type: "peers", peers: string[] }
type Hash = string
type GetObjectMessage = { type: "getobject", objectid: Hash }
type IHaveObjectMessage = { type: "ihaveobject", objectid: Hash }
type Object = { type: "block", txids: string[], nonce: string, previd: string | null, created: string, T: string }
type ObjectMessage = { type: "object", object: Object }
type GetMempoolMessage = { type: "getmempool" }
type MempoolMessage = { type: "mempool", txids: string[] }
type GetChainTipMessage = { type: "getchaintip" }
type ChainTipMessage = { type: "chaintip", "blockid": Hash }
type Message = HelloMessage | ErrorCode | ErrorMessage | GetPeersMessage | PeersMessage | Hash | GetObjectMessage | IHaveObjectMessage | Object | ObjectMessage | GetMempoolMessage | MempoolMessage | GetChainTipMessage | ChainTipMessage

const server = net.createServer((socket) => {
    console.log('client connected')
    socket.on('end', () => {
        console.log('client disconnected')
    })
    socket.on('error', (err) => {
        console.log(`Error: ${err}`)
    })
    socket.write('hello\r\n')

    let messages: string = ""

    socket.on('data', (chunk) => {
        try {
            messages += chunk.toString()
            let eom = messages.indexOf('\n')
            while (eom != -1) {
                const message: Message = JSON.parse(messages.substring(0, eom))

                messages = messages.substring(eom + 1)
                console.log(message)
                eom = messages.indexOf('\n')
            }
        }
        catch (err) {
            let error: ErrorMessage = { type: "error", name: "INTERNAL_ERROR", message: "Something unexpected happened." }
            if (err instanceof SyntaxError) {
                error.name = "INVALID_FORMAT"
                error.message = "The format of the received message is invalid."
            }
            socket.write(canonicalize(error))
            socket.destroy()
        }
    })
})
server.on('error', (err) => {
    throw err
})
server.listen({ port: 18018, host: 'localhost' }, () => {
    console.log('server bound')
})

