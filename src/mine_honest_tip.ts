import { createHash } from 'blake2'
import * as child from 'child_process'
import { canonicalize } from 'json-canonicalize'
// import { Static } from 'runtypes';
// import { BlockObject, BlockObjectType, TransactionObjectType, CoinbaseTransactionObject, HelloMessageType, ObjectMessageType } from './message';
import * as z from 'zod'
import {Object, BlockObject, TransactionObject, HelloMessage, ObjectMessage} from './types'

const NAME = 'Undertaker OVERKILL (GitHub: arjvik/undertaker, branch pset6_mine_honest_tip, commit {{GIT-HASH}})'

type CoinbaseTransactionObjectType = z.infer<typeof TransactionObject>

const JOBS = 12;

const buildCoinbase = (height: number): CoinbaseTransactionObjectType => ({
    "height": height,
    "outputs": [
        {
            "pubkey": "ee37413dd87d1a056da15f6ebfef6a9dc1691f2828f02c69a58520098506aedc",
            "value": 50000000000000
        }],
    "type": "transaction"
})

const hashObject = (object: Object) =>
    createHash('blake2s', { digestLength: 32 })
        .update(Buffer.from(canonicalize(object), 'utf8'))
        .digest('hex')

const buildBlockTemplate = (height: number, timestamp: number, prevBlock: string, coinbase: TransactionObject): BlockObject => ({
    "T": "00000000abc00000000000000000000000000000000000000000000000000000",
    "created": timestamp,
    "miner": NAME,
    "nonce":"<<NONCE>>",
    "note":`Block Height: ${height}`,
    "previd": prevBlock,
    "studentids":["arjvik","aalinur"],
    "txids":[hashObject(coinbase)],
    "type":"block"
  })


let height = 1481
let timestamp = 1678732079 + 1
let previous = "00000000197d0f65502d8bbd732d37ca01f28571d1b5568fa5d261bb7d9aaf5b"

console.log(canonicalize({type: 'hello', agent: 'netcat', version: '0.10.0'} as HelloMessage))
const mine = () => {
    let coinbase = buildCoinbase(height)
    let [prefix, suffix] = canonicalize(buildBlockTemplate(height, timestamp, previous, coinbase)).split('<<NONCE>>')
    let minerProcess = child.spawn('parallel', ['--will-cite',
        '-j', JOBS.toString(),
        '--halt', 'now,done=1',
        './hasher', `'${prefix}'`, `'${suffix}'`,
        `:::`, ...Array(JOBS).fill(null).map((_, i) => i.toString())])
    minerProcess.stdout?.on('data', (data) => {
        const mined = BlockObject.parse(JSON.parse(data))
        console.log({type: 'object', object: coinbase} as ObjectMessage)
        console.log({type: 'object', object: mined} as ObjectMessage)
        height++
        timestamp++
        previous = hashObject(mined)
        minerProcess.kill()
        mine()
    })
}
mine()

process.on('SIGINT', () => process.exit(0))

const wait = () => {setTimeout(wait, 1000)}
wait()