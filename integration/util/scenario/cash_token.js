const { readContractsFile } = require('../ethereum');
const { Token } = require('./token');

class CashToken extends Token {
  constructor(cashToken, proxyAdmin, cashImpl, proxy, liquidityFactor, owner, ctx) {
    super('cash', 'CASH', 'Cash Token', 6, 'CASH', liquidityFactor, cashToken, owner, ctx);

    this.cashToken = cashToken;
    this.proxyAdmin = proxyAdmin;
    this.cashImpl = cashImpl;
    this.proxy = proxy;
  }

  toTrxArg() {
    return `CASH`;
  }

  toWeiAmount(tokenAmount) {
    if (tokenAmount === 'Max' || tokenAmount === 'MAX') {
      return tokenAmount;
    } else {
      return super.toWeiAmount(tokenAmount)
    }
  }

  lockEventName() {
    return 'LockedCash';
  }

  async cashIndex() {
    return this.cashToken.methods.getCashIndex().call();
  }

  async getCashPrincipal(actorLookup) {
    let actor = this.ctx.actors.get(actorLookup);
    return Number(await this.cashToken.methods.cashPrincipal(actor.ethAddress()).call());
  }

  async getTotalCashPrincipal() {
    return Number(await this.cashToken.methods.totalCashPrincipal().call());
  }

  async cashYieldStart() {
    return await this.cashToken.methods.cashYieldStart().call();
  }

  async getCashYieldAndIndex() {
    let { yield: theYield, index } = await this.cashToken.methods.cashYieldAndIndex().call();
    return { yield: theYield, index };
  }

  async nextCashYieldStart() {
    return await this.cashToken.methods.nextCashYieldStart().call();
  }

  async getNextCashYieldAndIndex() {
    let { yield: theYield, index } = await this.cashToken.methods.nextCashYieldAndIndex().call();
    return { yield: theYield, index };
  }

  async upgradeTo(version) {
    let newImpl = await this.ctx.eth.__deploy('CashToken', [this.ctx.starport.ethAddress()], { version });
    await this.upgrade(newImpl);
  }

  async getName() {
    return await this.cashToken.methods.name().call();
  }

  async getSymbol() {
    return await this.cashToken.methods.symbol().call();
  }

  async upgrade(impl, upgradeCall = null) {
    if (upgradeCall) {
      await this.proxyAdmin.methods.upgradeAndCall(
        this.cashToken._address,
        impl._address,
        upgradeCall
      ).send({ from: this.ctx.eth.root() });
    } else {
      let tx = await this.proxyAdmin.methods.upgrade(this.cashToken._address, impl._address).send({ from: this.ctx.eth.root() });
    }

    this.cashToken = this.ctx.eth.__getContractAtAbi(impl._jsonInterface, this.proxy._address);
  }
}

async function buildCashToken(cashTokenInfo, ctx, owner) {
  ctx.log("Deploying cash token...");

  let proxyAdmin = await ctx.eth.__deploy('ProxyAdmin', [], { from: ctx.eth.root() });
  let cashImpl = await ctx.eth.__deploy('CashToken', [owner]);
  let proxy = await ctx.eth.__deploy('TransparentUpgradeableProxy', [
    cashImpl._address,
    proxyAdmin._address,
    cashImpl.methods.initialize(ctx.__initialYield(), ctx.__initialYieldStart()).encodeABI()
  ], { from: ctx.eth.root() });
  let cashToken = await ctx.eth.__getContractAt('CashToken', proxy._address);

  return new CashToken(cashToken, proxyAdmin, cashImpl, proxy, cashTokenInfo.liquidity_factor, owner, ctx);
}

module.exports = {
  CashToken,
  buildCashToken
};
