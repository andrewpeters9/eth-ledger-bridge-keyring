import { TransactionFactory, TxData, TypedTransaction } from '@ethereumjs/tx';
import type LedgerHwAppEth from '@ledgerhq/hw-app-eth';
import { hasProperty } from '@metamask/utils';
// eslint-disable-next-line import/no-nodejs-modules
import { Buffer } from 'buffer';
import * as sigUtil from 'eth-sig-util';
import type OldEthJsTransaction from 'ethereumjs-tx';
import * as ethUtil from 'ethereumjs-util';
// eslint-disable-next-line import/no-nodejs-modules
import { EventEmitter } from 'events';
import HDKey from 'hdkey';

const pathBase = 'm';
const hdPathString = `${pathBase}/44'/60'/0'`;
const keyringType = 'Ledger Hardware';

const BRIDGE_URL = 'https://metamask.github.io/eth-ledger-bridge-keyring';

const MAX_INDEX = 1000;

const LEDGER_IFRAME_ID = 'LEDGER-IFRAME';

enum NetworkApiUrls {
  Ropsten = 'http://api-ropsten.etherscan.io',
  Kovan = 'http://api-kovan.etherscan.io',
  Rinkeby = 'https://api-rinkeby.etherscan.io',
  Mainnet = 'https://api.etherscan.io',
}

enum IFrameMessageAction {
  LedgerConnectionChange = 'ledger-connection-change',
  LedgerUnlock = 'ledger-unlock',
  LedgerMakeApp = 'ledger-make-app',
  LedgerUpdateTransport = 'ledger-update-transport',
  LedgerSignTransaction = 'ledger-sign-transaction',
  LedgerSignPersonalMessage = 'ledger-sign-personal-message',
  LedgerSignTypedData = 'ledger-sign-typed-data',
}

type GetAddressPayload = Awaited<ReturnType<LedgerHwAppEth['getAddress']>> & {
  chainCode: string;
};

type SignMessagePayload = Awaited<
  ReturnType<LedgerHwAppEth['signEIP712HashedMessage']>
>;

type SignTransactionPayload = Awaited<
  ReturnType<LedgerHwAppEth['signTransaction']>
>;

type ConnectionChangedPayload = {
  connected: boolean;
};

type IFrameMessage = {
  action: IFrameMessageAction;
  params?: Readonly<Record<string, unknown>>;
};

type IFramePostMessage = IFrameMessage & {
  messageId: number;
  target: typeof LEDGER_IFRAME_ID;
};

type IFrameMessageResponsePayload = { error?: Error } & (
  | GetAddressPayload
  | SignTransactionPayload
  | SignMessagePayload
  | ConnectionChangedPayload
);

export type IFrameMessageResponse = {
  success: boolean;
  action: IFrameMessageAction;
  messageId: number;
  payload: IFrameMessageResponsePayload;
  error?: unknown;
};

export type AccountDetails = {
  index?: number;
  bip44?: boolean;
  hdPath?: string;
};

export type LedgerBridgeKeyringOptions = {
  hdPath: string;
  accounts: readonly string[];
  accountDetails: Readonly<Record<string, AccountDetails>>;
  accountIndexes: Readonly<Record<string, number>>;
  bridgeUrl: string;
  implementFullBIP44: boolean;
};

/**
 * Check if the given transaction is made with ethereumjs-tx or @ethereumjs/tx
 *
 * Transactions built with older versions of ethereumjs-tx have a
 * getChainId method that newer versions do not.
 * Older versions are mutable
 * while newer versions default to being immutable.
 * Expected shape and type
 * of data for v, r and s differ (Buffer (old) vs BN (new)).
 *
 * @param tx - Transaction to check, instance of either ethereumjs-tx or @ethereumjs/tx.
 * @returns Returns `true` if tx is an old-style ethereumjs-tx transaction.
 */
function isOldStyleEthereumjsTx(
  tx: TypedTransaction | OldEthJsTransaction,
): tx is OldEthJsTransaction {
  return 'getChainId' in tx && typeof tx.getChainId === 'function';
}

/**
 * Check if the given payload is a SignTransactionPayload.
 *
 * @param payload - IFrame message response payload to check.
 * @returns Returns `true` if payload is a SignTransactionPayload.
 */
function isSignTransactionResponse(
  payload: IFrameMessageResponsePayload,
): payload is SignTransactionPayload {
  return hasProperty(payload, 'v') && typeof payload.v === 'string';
}

/**
 * Check if the given payload is a SignMessagePayload.
 *
 * @param payload - IFrame message response payload to check.
 * @returns Returns `true` if payload is a SignMessagePayload.
 */
function isSignMessageResponse(
  payload: IFrameMessageResponsePayload,
): payload is SignMessagePayload {
  return hasProperty(payload, 'v') && typeof payload.v === 'number';
}

/**
 * Check if the given payload is a GetAddressPayload.
 *
 * @param payload - IFrame message response payload to check.
 * @returns Returns `true` if payload is a GetAddressPayload.
 */
function isGetAddressMessageResponse(
  payload: IFrameMessageResponsePayload,
): payload is GetAddressPayload {
  return (
    hasProperty(payload, 'publicKey') && typeof payload.publicKey === 'string'
  );
}

/**
 * Check if the given payload is a ConnectionChangedPayload.
 *
 * @param payload - IFrame message response payload to check.
 * @returns Returns `true` if payload is a ConnectionChangedPayload.
 */
function isConnectionChangedResponse(
  payload: IFrameMessageResponsePayload,
): payload is ConnectionChangedPayload {
  return (
    hasProperty(payload, 'connected') && typeof payload.connected === 'boolean'
  );
}

export class LedgerBridgeKeyring extends EventEmitter {
  static type: string = keyringType;

  readonly type: string = keyringType;

  page = 0;

  perPage = 5;

  unlockedAccount = 0;

  accounts: readonly string[] = [];

  accountDetails: Record<string, AccountDetails> = {};

  hdk = new HDKey();

  hdPath = hdPathString;

  paths: Record<string, number> = {};

  network: NetworkApiUrls = NetworkApiUrls.Mainnet;

  implementFullBIP44 = false;

  iframeLoaded = false;

  isDeviceConnected = false;

  currentMessageId = 0;

  messageCallbacks: Record<number, (response: IFrameMessageResponse) => void> =
    {};

  bridgeUrl: string = BRIDGE_URL;

  iframe?: HTMLIFrameElement;

  delayedPromise?: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    transportType: string;
  };

  constructor(opts: Partial<LedgerBridgeKeyringOptions> = {}) {
    super();

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.deserialize(opts);

    this.#setupIframe();

    this.#setupListener();
  }

  async serialize() {
    return {
      hdPath: this.hdPath,
      accounts: this.accounts,
      accountDetails: this.accountDetails,
      bridgeUrl: this.bridgeUrl,
      implementFullBIP44: false,
    };
  }

  async deserialize(opts: Partial<LedgerBridgeKeyringOptions> = {}) {
    this.hdPath = opts.hdPath ?? hdPathString;
    this.bridgeUrl = opts.bridgeUrl ?? BRIDGE_URL;
    this.accounts = opts.accounts ?? [];
    this.accountDetails = opts.accountDetails ?? {};
    if (!opts.accountDetails) {
      this.#migrateAccountDetails(opts);
    }

    this.implementFullBIP44 = opts.implementFullBIP44 ?? false;

    // Remove accounts that don't have corresponding account details
    this.accounts = this.accounts.filter((account) =>
      Object.keys(this.accountDetails).includes(
        ethUtil.toChecksumAddress(account),
      ),
    );

    return Promise.resolve();
  }

  #migrateAccountDetails(opts: Partial<LedgerBridgeKeyringOptions>) {
    if (this.#isLedgerLiveHdPath() && opts.accountIndexes) {
      for (const [account, index] of Object.entries(opts.accountIndexes)) {
        this.accountDetails[account] = {
          bip44: true,
          hdPath: this.#getPathForIndex(index),
        };
      }
    }

    // try to migrate non-LedgerLive accounts too
    if (!this.#isLedgerLiveHdPath()) {
      this.accounts
        .filter(
          (account) =>
            !Object.keys(this.accountDetails).includes(
              ethUtil.toChecksumAddress(account),
            ),
        )
        .forEach((account) => {
          try {
            this.accountDetails[ethUtil.toChecksumAddress(account)] = {
              bip44: false,
              hdPath: this.#pathFromAddress(account),
            };
          } catch (error) {
            console.log(`failed to migrate account ${account}`);
          }
        });
    }
  }

  isUnlocked() {
    return Boolean(this.hdk?.publicKey);
  }

  isConnected() {
    return this.isDeviceConnected;
  }

  setAccountToUnlock(index: number | string) {
    this.unlockedAccount =
      typeof index === 'number' ? index : parseInt(index, 10);
  }

  setHdPath(hdPath: string) {
    // Reset HDKey if the path changes
    if (this.hdPath !== hdPath) {
      this.hdk = new HDKey();
    }
    this.hdPath = hdPath;
  }

  async unlock(hdPath?: string, updateHdk = true): Promise<string> {
    if (this.isUnlocked() && !hdPath) {
      return 'already unlocked';
    }
    const path = hdPath ? this.#toLedgerPath(hdPath) : this.hdPath;
    return new Promise((resolve, reject) => {
      this.#sendMessage(
        {
          action: IFrameMessageAction.LedgerUnlock,
          params: {
            hdPath: path,
          },
        },
        ({ success, payload }) => {
          if (success && isGetAddressMessageResponse(payload)) {
            if (updateHdk) {
              this.hdk.publicKey = Buffer.from(payload.publicKey, 'hex');
              this.hdk.chainCode = Buffer.from(payload.chainCode, 'hex');
            }
            resolve(payload.address);
          } else {
            reject(payload.error ?? new Error('Unknown error'));
          }
        },
      );
    });
  }

  async addAccounts(amount = 1): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then(async (_) => {
          const from = this.unlockedAccount;
          const to = from + amount;
          for (let i = from; i < to; i++) {
            const path = this.#getPathForIndex(i);
            let address;
            if (this.#isLedgerLiveHdPath()) {
              address = await this.unlock(path);
            } else {
              address = this.#addressFromIndex(pathBase, i);
            }

            this.accountDetails[ethUtil.toChecksumAddress(address)] = {
              // TODO: consider renaming this property, as the current name is misleading
              // It's currently used to represent whether an account uses the Ledger Live path.
              bip44: this.#isLedgerLiveHdPath(),
              hdPath: path,
            };

            if (!this.accounts.includes(address)) {
              this.accounts = [...this.accounts, address];
            }
            this.page = 0;
          }
          resolve(this.accounts.slice());
        })
        .catch(reject);
    });
  }

  async getFirstPage() {
    this.page = 0;
    return this.#getPage(1);
  }

  async getNextPage() {
    return this.#getPage(1);
  }

  async getPreviousPage() {
    return this.#getPage(-1);
  }

  async getAccounts() {
    return Promise.resolve(this.accounts.slice());
  }

  removeAccount(address: string) {
    if (
      !this.accounts.map((a) => a.toLowerCase()).includes(address.toLowerCase())
    ) {
      throw new Error(`Address ${address} not found in this keyring`);
    }

    this.accounts = this.accounts.filter(
      (a) => a.toLowerCase() !== address.toLowerCase(),
    );
    delete this.accountDetails[ethUtil.toChecksumAddress(address)];
  }

  async attemptMakeApp() {
    return new Promise((resolve, reject) => {
      this.#sendMessage(
        {
          action: IFrameMessageAction.LedgerMakeApp,
        },
        ({ success, error }) => {
          if (success) {
            resolve(true);
          } else {
            reject(error);
          }
        },
      );
    });
  }

  async updateTransportMethod(transportType: string) {
    return new Promise((resolve, reject) => {
      // If the iframe isn't loaded yet, let's store the desired transportType value and
      // optimistically return a successful promise
      if (!this.iframeLoaded) {
        this.delayedPromise = {
          resolve,
          reject,
          transportType,
        };
        return;
      }

      this.#sendMessage(
        {
          action: IFrameMessageAction.LedgerUpdateTransport,
          params: { transportType },
        },
        ({ success }) => {
          if (success) {
            resolve(true);
          } else {
            reject(new Error('Ledger transport could not be updated'));
          }
        },
      );
    });
  }

  // tx is an instance of the ethereumjs-transaction class.
  async signTransaction(
    address: string,
    tx: TypedTransaction | OldEthJsTransaction,
  ): Promise<TypedTransaction | OldEthJsTransaction> {
    let rawTxHex;
    // transactions built with older versions of ethereumjs-tx have a
    // getChainId method that newer versions do not. Older versions are mutable
    // while newer versions default to being immutable. Expected shape and type
    // of data for v, r and s differ (Buffer (old) vs BN (new))
    if (isOldStyleEthereumjsTx(tx)) {
      // In this version of ethereumjs-tx we must add the chainId in hex format
      // to the initial v value. The chainId must be included in the serialized
      // transaction which is only communicated to ethereumjs-tx in this
      // value. In newer versions the chainId is communicated via the 'Common'
      // object.
      // @ts-expect-error tx.v should be a Buffer but we are assigning a string
      tx.v = ethUtil.bufferToHex(tx.getChainId());
      // @ts-expect-error tx.r should be a Buffer but we are assigning a string
      tx.r = '0x00';
      // @ts-expect-error tx.s should be a Buffer but we are assigning a string
      tx.s = '0x00';

      rawTxHex = tx.serialize().toString('hex');

      return this.#signTransaction(address, rawTxHex, (payload) => {
        tx.v = Buffer.from(payload.v, 'hex');
        tx.r = Buffer.from(payload.r, 'hex');
        tx.s = Buffer.from(payload.s, 'hex');
        return tx;
      });
    }

    // The below `encode` call is only necessary for legacy transactions, as `getMessageToSign`
    // calls `rlp.encode` internally for non-legacy transactions. As per the "Transaction Execution"
    // section of the ethereum yellow paper, transactions need to be "well-formed RLP, with no additional
    // trailing bytes".

    // Note also that `getMessageToSign` will return valid RLP for all transaction types, whereas the
    // `serialize` method will not for any transaction type except legacy. This is because `serialize` includes
    // empty r, s and v values in the encoded rlp. This is why we use `getMessageToSign` here instead of `serialize`.
    const messageToSign = tx.getMessageToSign(false);

    rawTxHex = Buffer.isBuffer(messageToSign)
      ? messageToSign.toString('hex')
      : ethUtil.rlp.encode(messageToSign).toString('hex');

    return this.#signTransaction(address, rawTxHex, (payload) => {
      // Because tx will be immutable, first get a plain javascript object that
      // represents the transaction. Using txData here as it aligns with the
      // nomenclature of ethereumjs/tx.
      const txData: TxData = tx.toJSON();
      // The fromTxData utility expects a type to support transactions with a type other than 0
      txData.type = tx.type;
      // The fromTxData utility expects v,r and s to be hex prefixed
      txData.v = ethUtil.addHexPrefix(payload.v);
      txData.r = ethUtil.addHexPrefix(payload.r);
      txData.s = ethUtil.addHexPrefix(payload.s);
      // Adopt the 'common' option from the original transaction and set the
      // returned object to be frozen if the original is frozen.
      return TransactionFactory.fromTxData(txData, {
        common: tx.common,
        freeze: Object.isFrozen(tx),
      });
    });
  }

  async #signTransaction(
    address: string,
    rawTxHex: string,
    handleSigning: (
      payload: SignTransactionPayload,
    ) => TypedTransaction | OldEthJsTransaction,
  ): Promise<TypedTransaction | OldEthJsTransaction> {
    return new Promise((resolve, reject) => {
      this.unlockAccountByAddress(address)
        .then((hdPath) => {
          this.#sendMessage(
            {
              action: IFrameMessageAction.LedgerSignTransaction,
              params: {
                tx: rawTxHex,
                hdPath,
              },
            },
            ({ success, payload }) => {
              if (success && isSignTransactionResponse(payload)) {
                const newOrMutatedTx = handleSigning(payload);
                const valid = newOrMutatedTx.verifySignature();
                if (valid) {
                  resolve(newOrMutatedTx);
                } else {
                  reject(
                    new Error('Ledger: The transaction signature is not valid'),
                  );
                }
              } else {
                reject(
                  payload.error ??
                    new Error(
                      'Ledger: Unknown error while signing transaction',
                    ),
                );
              }
            },
          );
        })
        .catch(reject);
    });
  }

  async signMessage(withAccount: string, data: string) {
    return this.signPersonalMessage(withAccount, data);
  }

  // For personal_sign, we need to prefix the message:
  async signPersonalMessage(withAccount: string, message: string) {
    return new Promise((resolve, reject) => {
      this.unlockAccountByAddress(withAccount)
        .then((hdPath) => {
          this.#sendMessage(
            {
              action: IFrameMessageAction.LedgerSignPersonalMessage,
              params: {
                hdPath,
                message: ethUtil.stripHexPrefix(message),
              },
            },
            ({ success, payload }) => {
              if (success && isSignMessageResponse(payload)) {
                let recoveryId = parseInt(String(payload.v), 10).toString(16);
                if (recoveryId.length < 2) {
                  recoveryId = `0${recoveryId}`;
                }
                const signature = `0x${payload.r}${payload.s}${recoveryId}`;
                const addressSignedWith = sigUtil.recoverPersonalSignature({
                  data: message,
                  // eslint-disable-next-line id-denylist
                  sig: signature,
                });
                if (
                  ethUtil.toChecksumAddress(addressSignedWith) !==
                  ethUtil.toChecksumAddress(withAccount)
                ) {
                  reject(
                    new Error(
                      'Ledger: The signature doesnt match the right address',
                    ),
                  );
                }
                resolve(signature);
              } else {
                reject(
                  payload.error ??
                    new Error('Ledger: Unknown error while signing message'),
                );
              }
            },
          );
        })
        .catch(reject);
    });
  }

  async unlockAccountByAddress(address: string) {
    const checksummedAddress = ethUtil.toChecksumAddress(address);
    const accountDetails = this.accountDetails[checksummedAddress];
    if (!accountDetails) {
      throw new Error(
        `Ledger: Account for address '${checksummedAddress}' not found`,
      );
    }
    const { hdPath } = accountDetails;
    const unlockedAddress = await this.unlock(hdPath, false);

    // unlock resolves to the address for the given hdPath as reported by the ledger device
    // if that address is not the requested address, then this account belongs to a different device or seed
    if (unlockedAddress.toLowerCase() !== address.toLowerCase()) {
      throw new Error(
        `Ledger: Account ${address} does not belong to the connected device`,
      );
    }
    return hdPath;
  }

  async signTypedData(
    withAccount: string,
    data: sigUtil.EIP712TypedData,
    options: { version?: string } = {},
  ) {
    const isV4 = options.version === 'V4';
    if (!isV4) {
      throw new Error(
        'Ledger: Only version 4 of typed data signing is supported',
      );
    }

    const { domain, types, primaryType, message } =
      sigUtil.TypedDataUtils.sanitizeData(data);
    const domainSeparatorHex = sigUtil.TypedDataUtils.hashStruct(
      'EIP712Domain',
      domain,
      types,
      // @ts-expect-error @types/eth-sig-util documents this function
      // as taking three arguments, but it actually takes four.
      // See: https://github.com/MetaMask/eth-sig-util/blob/v2.5.4/index.js#L174
      isV4,
    ).toString('hex');
    const hashStructMessageHex = sigUtil.TypedDataUtils.hashStruct(
      primaryType,
      message,
      types,
      // @ts-expect-error see comment above
      isV4,
    ).toString('hex');

    const hdPath = await this.unlockAccountByAddress(withAccount);
    const { success, payload }: IFrameMessageResponse = await new Promise(
      (resolve) => {
        this.#sendMessage(
          {
            action: IFrameMessageAction.LedgerSignTypedData,
            params: {
              hdPath,
              domainSeparatorHex,
              hashStructMessageHex,
            },
          },
          (result) => resolve(result),
        );
      },
    );

    if (success && isSignMessageResponse(payload)) {
      let recoveryId = parseInt(String(payload.v), 10).toString(16);
      if (recoveryId.length < 2) {
        recoveryId = `0${recoveryId}`;
      }
      const signature = `0x${payload.r}${payload.s}${recoveryId}`;
      // @ts-expect-error recoverTypedSignature_v4 is missing from
      // @types/eth-sig-util.
      // See: https://github.com/MetaMask/eth-sig-util/blob/v2.5.4/index.js#L464
      const addressSignedWith = sigUtil.recoverTypedSignature_v4({
        data,
        // eslint-disable-next-line id-denylist
        sig: signature,
      });
      if (
        ethUtil.toChecksumAddress(addressSignedWith) !==
        ethUtil.toChecksumAddress(withAccount)
      ) {
        throw new Error('Ledger: The signature doesnt match the right address');
      }
      return signature;
    }
    throw (
      payload.error ?? new Error('Ledger: Unknown error while signing message')
    );
  }

  exportAccount() {
    throw new Error('Not supported on this device');
  }

  forgetDevice() {
    this.accounts = [];
    this.page = 0;
    this.unlockedAccount = 0;
    this.paths = {};
    this.accountDetails = {};
    this.hdk = new HDKey();
  }

  /* PRIVATE METHODS */

  #setupIframe() {
    this.iframe = document.createElement('iframe');
    this.iframe.src = this.bridgeUrl;
    this.iframe.allow = `hid 'src'`;
    this.iframe.onload = async () => {
      // If the ledger live preference was set before the iframe is loaded,
      // set it after the iframe has loaded
      this.iframeLoaded = true;
      if (this.delayedPromise) {
        try {
          const result = await this.updateTransportMethod(
            this.delayedPromise.transportType,
          );
          this.delayedPromise.resolve(result);
        } catch (error) {
          this.delayedPromise.reject(error);
        } finally {
          delete this.delayedPromise;
        }
      }
    };
    document.head.appendChild(this.iframe);
  }

  #getOrigin() {
    const tmp = this.bridgeUrl.split('/');
    tmp.splice(-1, 1);
    return tmp.join('/');
  }

  #eventListener(params: { origin: string; data: IFrameMessageResponse }) {
    if (params.origin !== this.#getOrigin()) {
      return false;
    }

    if (params.data) {
      const messageCallback = this.messageCallbacks[params.data.messageId];
      if (messageCallback) {
        messageCallback(params.data);
      } else if (
        params.data.action === IFrameMessageAction.LedgerConnectionChange &&
        isConnectionChangedResponse(params.data.payload)
      ) {
        this.isDeviceConnected = params.data.payload.connected;
      }
    }

    return undefined;
  }

  #sendMessage(
    message: IFrameMessage,
    callback: (response: IFrameMessageResponse) => void,
  ) {
    this.currentMessageId += 1;

    const postMsg: IFramePostMessage = {
      ...message,
      messageId: this.currentMessageId,
      target: LEDGER_IFRAME_ID,
    };

    this.messageCallbacks[this.currentMessageId] = callback;

    if (!this.iframeLoaded || !this.iframe || !this.iframe.contentWindow) {
      throw new Error('The iframe is not loaded yet');
    }

    this.iframe.contentWindow.postMessage(postMsg, '*');
  }

  #setupListener() {
    window.addEventListener('message', this.#eventListener.bind(this));
  }

  destroy() {
    window.removeEventListener('message', this.#eventListener.bind(this));
  }

  async #getPage(increment: number) {
    this.page += increment;

    if (this.page <= 0) {
      this.page = 1;
    }
    const from = (this.page - 1) * this.perPage;
    const to = from + this.perPage;

    await this.unlock();
    let accounts;
    if (this.#isLedgerLiveHdPath()) {
      accounts = await this.#getAccountsBIP44(from, to);
    } else {
      accounts = this.#getAccountsLegacy(from, to);
    }
    return accounts;
  }

  async #getAccountsBIP44(from: number, to: number) {
    const accounts: {
      address: string;
      balance: number | null;
      index: number;
    }[] = [];

    for (let i = from; i < to; i++) {
      const path = this.#getPathForIndex(i);
      const address = await this.unlock(path);
      const valid = this.implementFullBIP44
        ? await this.#hasPreviousTransactions(address)
        : true;
      accounts.push({
        address,
        balance: null,
        index: i,
      });

      // PER BIP44
      // "Software should prevent a creation of an account if
      // a previous account does not have a transaction history
      // (meaning none of its addresses have been used before)."
      if (!valid) {
        break;
      }
    }
    return accounts;
  }

  #getAccountsLegacy(from: number, to: number) {
    const accounts: {
      address: string;
      balance: number | null;
      index: number;
    }[] = [];

    for (let i = from; i < to; i++) {
      const address = this.#addressFromIndex(pathBase, i);
      accounts.push({
        address,
        balance: null,
        index: i,
      });
      this.paths[ethUtil.toChecksumAddress(address)] = i;
    }
    return accounts;
  }

  #addressFromIndex(basePath: string, i: number) {
    const dkey = this.hdk.derive(`${basePath}/${i}`);
    const address = ethUtil
      .publicToAddress(dkey.publicKey, true)
      .toString('hex');
    return ethUtil.toChecksumAddress(`0x${address}`);
  }

  #pathFromAddress(address: string) {
    const checksummedAddress = ethUtil.toChecksumAddress(address);
    let index = this.paths[checksummedAddress];
    if (typeof index === 'undefined') {
      for (let i = 0; i < MAX_INDEX; i++) {
        if (checksummedAddress === this.#addressFromIndex(pathBase, i)) {
          index = i;
          break;
        }
      }
    }

    if (typeof index === 'undefined') {
      throw new Error('Unknown address');
    }
    return this.#getPathForIndex(index);
  }

  #getPathForIndex(index: number) {
    // Check if the path is BIP 44 (Ledger Live)
    return this.#isLedgerLiveHdPath()
      ? `m/44'/60'/${index}'/0/0`
      : `${this.hdPath}/${index}`;
  }

  #isLedgerLiveHdPath() {
    return this.hdPath === `m/44'/60'/0'/0/0`;
  }

  #toLedgerPath(path: string) {
    return path.toString().replace('m/', '');
  }

  async #hasPreviousTransactions(address: string) {
    const apiUrl = this.#getApiUrl();
    const response = await window.fetch(
      `${apiUrl}/api?module=account&action=txlist&address=${address}&tag=latest&page=1&offset=1`,
    );
    const parsedResponse = await response.json();
    if (parsedResponse.status !== '0' && parsedResponse.result.length > 0) {
      return true;
    }
    return false;
  }

  #getApiUrl() {
    return this.network;
  }
}
