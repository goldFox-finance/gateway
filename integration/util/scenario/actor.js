const { Keyring } = require('@polkadot/api');
const { getInfoKey } = require('../util');
const { instantiateInfo } = require('./scen_info');
const { descale, sendAndWaitForEvents } = require('../substrate');
const { lookupBy } = require('../util');
const { CashToken } = require('./cash_token');

class Actor {
  constructor(name, ethAddress, chainKey, ctx) {
    this.name = name;
    this.__ethAddress = ethAddress;
    this.chainKey = chainKey;
    this.ctx = ctx;
    this.nextId = 0;
  }

  show() {
    return this.name;
  }

  ethAddress() {
    if (!this.__ethAddress) {
      throw new Error(`Actor ${this.name} does not have a valid eth account`);
    }

    return this.__ethAddress;
  }

  toChainAccount() {
    return { Eth: this.ethAddress() };
  }

  toTrxArg() {
    return `Eth:${this.ethAddress()}`;
  }

  declareInfo() {
    return {
      active: "I am going to",
      past: "I just did",
      failed: "I failed to",
      colorId: [...this.name].reduce((acc, el) => el.charCodeAt(0) + acc, 0),
      id: this.nextId++,
      name: this.name
    };
  }

  declare(...args) {
    return this.ctx.declare(this.declareInfo(), ...args);
  }

  async nonce() {
    return await this.ctx.api().query.cash.nonces(this.toChainAccount());
  }

  async sign(data) {
    return await this.ctx.eth.sign(data, this);
  }

  async signWithNonce(data) {
    let currentNonce = await this.nonce();
    let signature = await this.sign(`${currentNonce}:${data}`);

    return [ { Eth: [ this.ethAddress(), signature ] }, currentNonce ];
  }

  async runTrxRequest(trxReq) {
    let [sig, currentNonce] = await this.signWithNonce(trxReq);
    let call = this.ctx.api().tx.cash.execTrxRequest(trxReq, sig, currentNonce);

    return await this.ctx.eventTracker.sendAndWaitForEvents(call, { onFinalize: false });
  }

  async ethBalance() {
    return await this.ctx.eth.ethBalance(this);
  }

  async tokenBalance(tokenLookup) {
    let token = this.ctx.tokens.get(tokenLookup);
    return await token.getBalance(this);
  }

  async chainCashPrincipal_() {
    return await this.ctx.api().query.cash.cashPrincipals(this.toChainAccount());
  }

  async chainCashPrincipal() {
    return descale(await this.chainCashPrincipal_(), 6);
  }

  async chainCashBalance_() {
    let chainCashPrincipal = await this.chainCashPrincipal_();
    let cashIndex = await this.ctx.chain.cashIndex();
    return chainCashPrincipal.toBigInt() * cashIndex.toBigInt();
  }

  async chainCashBalance() {
    return descale(await this.chainCashBalance_(), 18 + 6);
  }

  async chainBalance(tokenLookup) {
    let token = this.ctx.tokens.get(tokenLookup);
    if (token instanceof CashToken) {
      return await this.cash();
    } else {
      let weiAmount = await this.ctx.api().query.cash.assetBalances(token.toChainAsset(), this.toChainAccount());
      return token.toTokenAmount(weiAmount);
    }
  }

  async chainBalanceFromRPC(tokenLookup) {
    let token = this.ctx.tokens.get(tokenLookup);
    if (token instanceof CashToken) {
      return await this.cash();
    } else {
      let assetdata = await this.ctx.api().rpc.gateway.assetdata(this.toTrxArg(), token.toTrxArg());
      let weiAmount = assetdata.balance
      return token.toTokenAmount(weiAmount);
    }
  }

  async cashForToken(token) {
    let assetBalance = await this.ctx.api().query.cash.assetBalances(token.toChainAsset(), this.toChainAccount());
    let lastIndex = await this.ctx.api().query.cash.lastIndices(token.toChainAsset(), this.toChainAccount());

    if (assetBalance == 0) {
      return 0;
    } else if (assetBalance > 0) {
      // Read CashPrincipalPost=CashPrincipalPre+AssetBalanceOld(SupplyIndexAsset-LastIndexAsset, Account)
      let supplyIndex = await this.ctx.api().query.cash.supplyIndices(token.toChainAsset());
      return descale(assetBalance.toBigInt() * (supplyIndex.toBigInt() - lastIndex.toBigInt()), 18 + token.decimals);
    } else {
      // Read CashPrincipalPost=CashPrincipalPre+AssetBalanceOld(BorrowIndexAsset-LastIndexAsset, Account)
      let borrowIndex = await this.ctx.api().query.cash.borrowIndices(token.toChainAsset());
      return descale(assetBalance.toBigInt() * (borrowIndex.toBigInt() - lastIndex.toBigInt()), 18 + token.decimals);
    }
  }

  async cash() {
    // TODO: Use non-zero balances
    let cashForTokens = await Promise.all(this.ctx.tokens.all().map((token) => this.cashForToken(token)));
    let chainCashBalance = await this.chainCashBalance();
    return chainCashBalance + cashForTokens.reduce((acc, el) => acc + el, 0);
  }

  async liquidityForToken(token) {
    let assetBalance = await this.ctx.api().query.cash.assetBalances(token.toChainAsset(), this.toChainAccount());
    let price = await token.getPrice();
    let liquidityFactor = await token.getLiquidityFactor();

    if (assetBalance == 0) {
      return 0;
    } else if (assetBalance > 0) {
      // AssetBalance • LiquidityFactor_Asset • Price_Asset
      return token.toTokenAmount(assetBalance.toBigInt()) * price * liquidityFactor;
    } else {
      // AssetBalance ÷ LiquidityFactor_Asset • Price_Asset
      return token.toTokenAmount(assetBalance.toBigInt()) * price / liquidityFactor;
    }
  }

  async liquidity() {
    // TODO: Use non-zero balances
    let liquidityForTokens = await Promise.all(this.ctx.tokens.all().map((token) => this.liquidityForToken(token)));
    return await this.cash() + liquidityForTokens.reduce((acc, el) => acc + el, 0);
  }

  async lock(amount, asset, opts = {}) {
    opts = {
      awaitEvent: true,
      ...opts
    };

    return await this.declare("lock", [amount, asset], async () => {
      let tx = await this.ctx.starport.lock(this, amount, asset);
      let event;
      if (opts.awaitEvent) {
        event = await this.ctx.chain.waitForEthProcessEvent('cash', asset.lockEventName());
      }
      return {
        event,
        tx,
      };
    });
  }

  async lockTo(amount, asset, recipient, opts = {}) {
    opts = {
      awaitEvent: true,
      ...opts
    };
    return await this.declare("lock", [amount, asset, "to", recipient], async () => {
      let tx = await this.ctx.starport.lockTo(this, amount, asset, 'ETH', recipient);
      let event;
      if (opts.awaitEvent) {
        event = await this.ctx.chain.waitForEthProcessEvent('cash', asset.lockEventName());
      }
      return {
        event,
        tx
      };
    });
  }

  async extract(amount, asset, recipient = null) {
    return await this.declare("extract", [amount, asset, "for", recipient || "myself"], async () => {
      let trxReq = this.extractTrxReq(amount, asset, recipient);

      this.ctx.log(`Running Trx Request \`${trxReq}\` from ${this.name}`);

      return await this.runTrxRequest(trxReq);
    });
  }

  async liquidate(liquidateAmount, borrowedAsset, collateralAsset, borrower) {
    return await this.declare("liquidate", [liquidateAmount, borrowedAsset, "for", collateralAsset, "from", borrower], async () => {
      let trxReq = this.liquidateTrxReq(liquidateAmount, borrowedAsset, collateralAsset, borrower);

      this.ctx.log(`Running Trx Request \`${trxReq}\` from ${this.name}`);

      return await this.runTrxRequest(trxReq);
    });
  }

  async execTrxRequest(trxRequest, awaitEvent = true) {
    return await this.ctx.starport.execTrxRequest(this, trxRequest, awaitEvent);
  }

  extractTrxReq(amount, asset, recipient = null) {
    let token = this.ctx.tokens.get(asset);
    let weiAmount = token.toWeiAmount(amount);

    return this.ctx.generateTrxReq("Extract", weiAmount, token, recipient || this);
  }

  liquidateTrxReq(liquidateAmount, borrowedAsset, collateralAsset, borrower) {
    let borrowedToken = this.ctx.tokens.get(borrowedAsset);
    let weiLiquidateAmount = borrowedToken.toWeiAmount(liquidateAmount);
    let collateralToken = this.ctx.tokens.get(collateralAsset);

    return this.ctx.generateTrxReq("Liquidate", weiLiquidateAmount, borrowedToken, collateralToken, borrower);
  }

  async transfer(amount, asset, recipient) {
    return await this.declare("transfer", [amount, asset, "to", recipient], async () => {
      let token = this.ctx.tokens.get(asset);
      let weiAmount = token.toWeiAmount(amount);

      let trxReq = this.ctx.generateTrxReq("Transfer", weiAmount, token, recipient);

      this.ctx.log(`Running Trx Request \`${trxReq}\` from ${this.name}`);

      return await this.runTrxRequest(trxReq);
    });
  }
}

class Actors {
  constructor(actors, keyring, ctx) {
    this.actors = actors;
    this.keyring = keyring;
    this.ctx = ctx;
  }

  all() {
    return this.actors;
  }

  first() {
    return this.actors[0];
  }

  get(lookup) {
    return lookupBy(Actor, 'name', this.actors, lookup);
  }
}

function actorInfoMap(keyring) {
  return {
    ashley: {
      key_uri: '//Alice'
    },
    bert: {
      key_uri: '//Bob'
    },
    chuck: {
      key_uri: '//Charlie'
    }
  };
}

async function buildActor(actorName, actorInfo, keyring, index, ctx) {
  let ethAddress = ctx.eth.accounts[index + 1];
  let chainKey = keyring.addFromUri(getInfoKey(actorInfo, 'key_uri', `actor ${actorName}`))

  return new Actor(actorName, ethAddress, chainKey, ctx);
}

async function getActorsInfo(actorsInfoHash, keyring, ctx) {
  let actorInfoMap = actorInfo(keyring);

  if (Array.isArray(actorsInfoHash)) {
    return actorsInfoHash.map((t) => {
      if (typeof (t) === 'string') {
        if (!actorInfoMap[t]) {
          throw new Error(`Unknown Actor: ${t}`);
        } else {
          return [t, actorInfoMap[t]];
        }
      } else {
        let {
          name,
          ...restActor
        } = t;
        return [name, restActor];
      }
    });
  } else {
    return Object.entries(actorsInfoHash);
  }
}

async function buildActors(actorsInfoHash, defaultActor, ctx) {
  let keyring = new Keyring({ type: 'sr25519' });

  let actorsInfo = await instantiateInfo(actorsInfoHash, 'Actor', 'name', actorInfoMap(keyring));
  let actors = await Promise.all(actorsInfo.map(([actorName, actorInfo], index) => {
    return buildActor(actorName, actorInfo, keyring, index, ctx);
  }));

  // TODO: Default actor
  return new Actors(actors, keyring, ctx);
}

module.exports = {
  Actor,
  Actors,
  buildActor,
  buildActors
};
