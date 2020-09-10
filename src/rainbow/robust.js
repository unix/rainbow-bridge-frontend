/// This module gives a few utils for robust error handling,
/// and wrap web3 with error handling and retry
const Web3 = require('web3')
const _ = require('lodash')
const nearlib = require('near-api-js')

const RETRY = 10
const DELAY = 500
const BACKOFF = 1.2

const retry = (retries, fn) =>
  fn().catch((err) =>
    retries > 1 ? retry(retries - 1, fn) : Promise.reject(err)
  )
const sleep = (duration) => new Promise((res) => setTimeout(res, duration))

const backoff = (retries, fn, delay = DELAY, wait = BACKOFF) =>
  fn().catch((err) =>
    retries > 1
      ? sleep(delay).then(() => backoff(retries - 1, fn, delay * wait))
      : Promise.reject(err)
  )

const SLOW_TX_ERROR_MSG = 'transaction not executed within 5 minutes'

class RobustWeb3 {
  constructor (ethNodeUrl) {
    this.ethNodeUrl = ethNodeUrl
    this.web3 = new Web3(ethNodeUrl)
  }

  async getBlockNumber () {
    return await backoff(RETRY, async () => {
      try {
        return await this.web3.eth.getBlockNumber()
      } catch (e) {
        if (e && e.toString() === 'Error: connection not open') {
          this.web3.setProvider(this.ethNodeUrl)
        }
      }
    })
  }

  async getBlock (b) {
    return await backoff(RETRY, async () => {
      try {
        return await this.web3.eth.getBlock(b)
      } catch (e) {
        if (e && e.toString() === 'Error: connection not open') {
          this.web3.setProvider(this.ethNodeUrl)
        }
      }
    })
  }

  async callContract (contract, method, args, options) {
    let gasPrice = await this.web3.eth.getGasPrice()
    let nonce = await this.web3.eth.getTransactionCount(options.from, 'pending')
    while (gasPrice < 10000 * 1e9) {
      try {
        // Keep sending with same nonce but higher gasPrice to override same txn
        const tx = {
          from: options.from,
          to: contract.options.address,
          gas: Web3.utils.toHex(options.gas),
          gasPrice: Web3.utils.toHex(gasPrice),
          nonce: Web3.utils.toHex(nonce),
          data: contract.methods[method](...args).encodeABI()
        }

        const receipt = await promiseWithTimeout(
          5 * 60 * 1000,
          this.web3.eth.sendTransaction(tx),
          SLOW_TX_ERROR_MSG
        )
        if (_.isArray(receipt.logs)) {
          // decode logs
          var events = _.map(receipt.logs, function (log) {
            return contract._decodeEventABI.call(
              {
                name: 'ALLEVENTS',
                jsonInterface: contract.options.jsonInterface
              },
              log
            )
          })

          // make log names keys
          receipt.events = {}
          var count = 0
          events.forEach(function (ev) {
            if (ev.event) {
              // if > 1 of the same event, don't overwrite any existing events
              if (receipt.events[ev.event]) {
                if (Array.isArray(receipt.events[ev.event])) {
                  receipt.events[ev.event].push(ev)
                } else {
                  receipt.events[ev.event] = [receipt.events[ev.event], ev]
                }
              } else {
                receipt.events[ev.event] = ev
              }
            } else {
              receipt.events[count] = ev
              count++
            }
          })
          delete receipt.logs
        }
        return receipt
      } catch (e) {
        if (e.message === SLOW_TX_ERROR_MSG) {
          console.log(SLOW_TX_ERROR_MSG)
          console.log(
            `current gasPrice: ${gasPrice}. resend tx with double gasPrice`
          )
          gasPrice *= 2
        } else if (
          e.message.indexOf("the tx doesn't have the correct nonce") >= 0
        ) {
          console.log('nonce error, retrying with new nonce')
          nonce++
        } else if (e.toString() === 'Error: connection not open') {
          console.log('web3 disconnected, reconnecting')
          this.web3.setProvider(this.ethNodeUrl)
        } else {
          throw e
        }
      }
    }
    throw new Error('Cannot finish txn within 1e13 gas')
  }

  async getTransactionReceipt (t) {
    return await backoff(RETRY, async () => {
      try {
        return await this.web3.eth.getTransactionReceipt(t)
      } catch (e) {
        if (e && e.toString() === 'Error: connection not open') {
          this.web3.setProvider(this.ethNodeUrl)
        }
      }
    })
  }

  destroy () {
    if (this.web3.currentProvider.connection.close) {
      // Only WebSocket provider has close, HTTPS don't
      this.web3.currentProvider.connection.close()
    }
  }
}

function normalizeEthKey (key) {
  let result = key.toLowerCase()
  if (!result.startsWith('0x')) {
    result = '0x' + result
  }
  return result
}

const promiseWithTimeout = (timeoutMs, promise, failureMessage) => {
  let timeoutHandle
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(failureMessage)),
      timeoutMs
    )
  })

  return Promise.race([promise, timeoutPromise]).then((result) => {
    clearTimeout(timeoutHandle)
    return result
  })
}

async function nearJsonContractFunctionCall (
  contractId,
  sender,
  method,
  args,
  gas,
  amount
) {
  // A robust version of near-api-js account.functionCall. We can't simply retry account.functionCall because
  // we don't know whether txn successfully submitted when timeout, so there's a risk of double sending

  await sender.ready
  const accessKey = await sender.findAccessKey()
  return await signAndSendTransaction(accessKey, sender, contractId, [
    nearlib.transactions.functionCall(
      method,
      Buffer.from(JSON.stringify(args)),
      gas,
      amount
    )
  ])
}

const RETRY_SEND_TX = 1
const RETRY_TX_STATUS = 1

const signAndSendTransaction = async (
  accessKey,
  account,
  receiverId,
  actions
) => {
  // TODO: Find matching access key based on transaction
  let errorMsg
  let resendLast = false
  let sendTxnAsync
  let txHash

  for (let i = 0; i < RETRY_SEND_TX; i++) {
    try {
      if (resendLast) {
        console.log('resend txn')
        await sendTxnAsync()
        resendLast = false
      } else {
        const status = await account.connection.provider.status()
        let signedTx
        ;[txHash, signedTx] = await nearlib.transactions.signTransaction(
          receiverId,
          ++accessKey.nonce,
          actions,
          nearlib.utils.serialize.base_decode(
            status.sync_info.latest_block_hash
          ),
          account.connection.signer,
          account.accountId,
          account.connection.networkId
        )
        console.log({ signedTx })
        const bytes = signedTx.encode()
        sendTxnAsync = async () => {
          await account.connection.provider.sendJsonRpc('broadcast_tx_async', [
            Buffer.from(bytes).toString('base64')
          ])
          console.log('TxHash', nearlib.utils.serialize.base_encode(txHash))
        }
        await sendTxnAsync()
      }
    } catch (e) {
      // sleep to avoid socket hangout on retry too soon
      console.error(e)
      console.log('Retrying to broadcast transaction in 500ms')
      await sleep(500)
      continue
    }

    let result
    for (let j = 0; j < RETRY_TX_STATUS; j++) {
      try {
        result = await account.connection.provider.txStatus(
          txHash,
          account.accountId
        )
        if (
          result.status.SuccessValue !== undefined ||
          result.status.Failure !== undefined
        ) {
          break
        }
      } catch (e) {
        console.error(e)
        if (j + 1 < RETRY_TX_STATUS) {
          console.log(
            `Retrying to find status for TxHash in ${(j + 1) * 500}ms`
          )
        }
        await sleep((j + 1) * 500)
      }
    }

    if (result) {
      const flatLogs = [
        result.transaction_outcome,
        ...result.receipts_outcome
      ].reduce((acc, it) => acc.concat(it.outcome.logs), [])
      if (flatLogs && flatLogs.length) {
        console.log(flatLogs)
      }

      if (result.status.SuccessValue !== undefined) {
        return result
      }

      errorMsg = JSON.stringify(result.status.Failure)
      if (errorMsg.includes('Transaction nonce')) {
        // nonce incorrect, re-fetch nonce and retry
        continue
      } else {
        // Indeed txn error, retry doesn't help
        break
      }
    } else {
      // Still no result after a long time, resubmit txn
      resendLast = true
      continue
    }
  }

  throw new Error(
    errorMsg || `Could not complete transaction ${receiverId}.${
      actions.map(a => a.functionCall.methodName)
    }`
  )
}

module.exports = {
  retry,
  sleep,
  backoff,
  RobustWeb3,
  normalizeEthKey,
  promiseWithTimeout,
  nearJsonContractFunctionCall,
  signAndSendTransaction
}