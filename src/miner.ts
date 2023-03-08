import * as child from 'child_process';
import { Hash } from 'crypto';
import { canonicalize } from 'json-canonicalize';
import { chainManager } from './chain';
import { logger } from './logger';
import { BlockObject, BlockObjectType, TransactionObjectType } from './message';
import { network } from './network';
import { objectManager } from './object';
import { NAME } from './peer';

const JOBS = 15;

class Miner {
  private minerProcess: child.ChildProcess | null = null
  private height: number | null = null
  private coinbase: string | null = null
  private prevblock: string | null = null
  private block: BlockObjectType | null = null

  startMining() {
    logger.debug(`Starting miner..., height=${this.height} block: ${JSON.stringify(this.block)}`)
    if (this.minerProcess !== null) {
      this.minerProcess.kill('SIGKILL')
    }
    (this.block as BlockObjectType)['nonce'] = '<<NONCE>>'
    const [prefix, suffix] = canonicalize(this.block).split('<<NONCE>>')
    // this.minerProcess = child.spawn('./hasher', [prefix, suffix])
    this.minerProcess = child.spawn('parallel', ['--will-cite',
                                                 '-j', JOBS.toString(),
                                                 '--halt', 'now,done=1',
                                                 './hasher', `'${prefix}'`, `'${suffix}'`,
                                                 `:::`, ...Array(15).fill(null).map((_,i)=>i.toString())])
    this.minerProcess.stdout?.on('data', (data) => {
      logger.info(`Mined block ${data}`)
      const mined = BlockObject.check(JSON.parse(data))
      objectManager.put(mined)
      network.broadcast({
        type: 'ihaveobject',
        objectid: objectManager.id(mined)
      })
    });
  }
  async buildCoinbase(height: number, prevBlock: string) {
    const coinbase: TransactionObjectType = {
      "type": "transaction",
      "height": height,
      "outputs": [
        {
          "pubkey": "ee37413dd87d1a056da15f6ebfef6a9dc1691f2828f02c69a58520098506aedc",
          "value": 50000000000000
        }
      ]
    }
    await objectManager.put(coinbase)
    this.coinbase = objectManager.id(coinbase)
    network.broadcast({
      type: 'ihaveobject',
      objectid: this.coinbase
    })
    this.prevblock = prevBlock
    this.height = height
  }
  setTransactions(txs: string[]) {
    this.block = {
      "T": "00000000abc00000000000000000000000000000000000000000000000000000",
      "created": Math.floor(new Date().getTime() / 1000),
      "miner": NAME,
      "nonce":"<<NONCE>>",
      "note":`Block Height: ${this.height}`,
      "previd": this.prevblock,
      "studentids":["arjvik","aalinur"],
      "txids":[this.coinbase??'', ...txs],
      "type":"block"
    }
  }
}

export const miner = new Miner()