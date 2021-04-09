const { findEvent, getEventData, mapToJson, signAndSend } = require('../substrate');
const { arrayEquals, keccak256 } = require('../util');
const {
  getNoticeChainId,
  encodeNotice,
  getNoticeParentHash,
  getNoticeId,
  getRawHash,
} = require('./types');
const chalk = require('chalk');

const { u8aToHex } = require('@polkadot/util');
const { xxhashAsHex } = require('@polkadot/util-crypto');
const web3 = require('web3');

class Chain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  toSS58 (arr) {
    return this.ctx.actors.keyring.encodeAddress(new Uint8Array(arr.buffer));
  }

  toEthAddress(u8arr) {
    return web3.utils.toChecksumAddress(u8aToHex(u8arr));
  }

  // https://www.shawntabrizi.com/substrate/querying-substrate-storage-via-rpc/
  getStorageKey(moduleName, valueName) {
    let moduleHash = xxhashAsHex(moduleName, 128);
    let functionHash = xxhashAsHex(valueName, 128);
    return moduleHash + functionHash.slice(2);
  }

  api() {
    return this.ctx.api();
  }

  async waitForEvent(pallet, eventName, onFinalize = true, failureEvent = null) {
    return await this.ctx.eventTracker.waitForEvent(pallet, eventName, { failureEvent });
  }

  // Similar to wait for event, but will reject if it sees a `cash:FailedProcessingEthEvent` event
  async waitForEthProcessEvent(pallet, eventName, onFinalize = true) {
    return this.waitForEvent(pallet, eventName, { failureEvent: ['cash', 'FailedProcessingEthEvent'] });
  }

  async waitForEthProcessFailure(onFinalize = true) {
    return this.waitForEvent('cash', 'FailedProcessingEthEvent');
  }

  async waitForChainProcessed(onFinalize = true, failureEvent = null) {
    // TODO: Match transaction id?
    return await this.waitForEvent('cash', 'ProcessedChainEvent', { failureEvent });
  }

  async waitForNotice(onFinalize = true, failureEvent = null) {
    return getEventData(await this.waitForEvent('cash', 'Notice', { failureEvent }));
  }

  async getNoticeChain(notice) {
    // We're going to walk back from the latest notice, tracking
    // the last accepted and a chain since that notice
    let chainId = getNoticeChainId(notice);
    let targetHash = keccak256(notice.EncodedNotice);

    let [currNoticeId, currChainHash] = (await this.api().query.cash.latestNotice(chainId)).toJSON();
    let currHash = getRawHash(currChainHash);
    let currChain = [];

    while (currNoticeId) {
      let currNotice = (await this.api().query.cash.notices(chainId, currNoticeId)).toJSON();

      if (arrayEquals(currNoticeId, notice.NoticeId)) {
        return currChain;
      }

      let encodedNotice = encodeNotice(currNotice);
      let parentHash = getNoticeParentHash(currNotice);
      let isAccepted = await this.ctx.starport.isNoticeInvoked(currHash);

      if (isAccepted) {
        currChain = [encodedNotice];
      } else {
        currChain = [encodedNotice, ...currChain];
      }

      currNoticeId = (await this.api().query.cash.noticeHashes({ [chainId]: parentHash })).toJSON();
      currHash = parentHash;
    }

    throw new Error(`Notice not found in notice chain`);
  }

  async getNoticeSignatures(notice, opts = {}) {
    opts = {
      sleep: 3000,
      retries: 10,
      signatures: await this.ctx.validators.quorum(),
      ...opts
    };
    let chainId = getNoticeChainId(notice);
    let noticeState = await this.api().query.cash.noticeStates(chainId, notice.NoticeId);
    if (!noticeState.isPending) {
      throw new Error("Unexpected notice status (not pending)");
    }
    let noticeStatePending = noticeState.asPending;

    let signaturePairs = noticeStatePending.signature_pairs;

    if (!signaturePairs.asEth) {
      throw new Error("Unexpected signature pairs (not eth)");
    }
    let signaturePairsEth = signaturePairs.asEth;
    let pairs = signaturePairsEth.map((k) => k);

    if (pairs.length < opts.signatures) {
      if (opts.retries > 0) {
        await this.ctx.sleep(opts.sleep);
        return await this.getNoticeSignatures(notice, { ...opts, retries: opts.retries - 1 });
      } else {
        throw new Error(`Unable to get signed notice in sufficient retries`);
      }
    } else {
      return pairs;
    }
  }

  async postPrice(payload, signature, onFinalize = true) {
    return await this.ctx.eventTracker.sendAndWaitForEvents(this.api().tx.oracle.postPrice(payload, signature), { onFinalize });
  }

  async cashIndex() {
    return await this.ctx.api().query.cash.globalCashIndex();
  }

  async upgradeTo(version) {
    this.ctx.log(chalk.blueBright(`Upgrading Chain to version ${version.version}...`));
    let versionHash = await version.hash();
    let extrinsic = this.ctx.api().tx.cash.allowNextCodeWithHash(versionHash);

    await this.ctx.starport.executeProposal(`Upgrade Chain to ${version.version}`, [extrinsic]);
    expect(await this.nextCodeHash()).toEqual(versionHash);
    let event = await this.setNextCode(await version.wasm());
    expect(event).toEqual({
      CodeHash: versionHash,
      DispatchResult: {
        Ok: []
      }
    });
    this.ctx.log(chalk.blueBright(`Upgrade to version ${version.version} complete.`));
  }

  async displayBlock() {
    const signedBlock = await this.ctx.api().rpc.chain.getBlock();

    // the information for each of the contained extrinsics
    signedBlock.block.extrinsics.forEach((ex, index) => {
      // the extrinsics are decoded by the API, human-like view
      this.ctx.log(index, ex.toHuman());

      const { isSigned, meta, method: { args, method, section } } = ex;

      // explicit display of name, args & documentation
      this.ctx.log(`${section}.${method}(${args.map((a) => a.toString()).join(', ')})`);
      this.ctx.log(meta.documentation.map((d) => d.toString()).join('\n'));

      // signer/nonce info
      if (isSigned) {
        this.ctx.log(`signer=${ex.signer.toString()}, nonce=${ex.nonce.toString()}`);
      }
    });
  }

  async interestRateModel(token) {
    let asset = await this.ctx.api().query.cash.supportedAssets(token.toChainAsset());
    return asset.unwrap().rate_model.toJSON();
  }

  async noticeHold(chainId) {
    return (await this.api().query.cash.noticeHolds(chainId)).toJSON();
  }

  async noticeState(notice) {
    let chainId = getNoticeChainId(notice);
    let noticeState = await this.api().query.cash.noticeStates(chainId, notice.NoticeId);
    return noticeState.toJSON();
  }

  async cullNotices() {
    return await this.ctx.eventTracker.sendAndWaitForEvents(this.api().tx.cash.cullNotices());
  }

  async nextCodeHash() {
    return mapToJson(await this.ctx.api().query.cash.allowedNextCodeHash());
  }

  async setNextCode(code, onFinalize = true) {
    let events = await this.ctx.eventTracker.sendAndWaitForEvents(this.api().tx.cash.setNextCodeViaHash(code), { onFinalize });
    return getEventData(findEvent(events, 'cash', 'AttemptedSetCodeByHash'));
  }

  async version() {
    return (await this.api().consts.system.version).toJSON();
  }

  async lastRuntimeUpgrade() {
    return mapToJson(await this.api().query.system.lastRuntimeUpgrade());
  }

  async getRuntimeVersion() {
    return (await this.api().rpc.state.getRuntimeVersion()).toJSON();
  }

  async getSemVer() {
    let {
      authoringVersion,
      specVersion,
      implVersion
    } = await this.getRuntimeVersion();

    return [authoringVersion, specVersion, implVersion];
  }

  async pendingCashValidators() {
    let vals = await this.ctx.api().query.cash.nextValidators.entries();
    const authData = vals.map(([valIdRaw, chainKeys]) =>
      [
        this.toSS58(valIdRaw.args[0]),
        {eth_address: this.toEthAddress(chainKeys.unwrap().eth_address)}
      ]
    );
    return authData;
  }

  async cashValidators() {
    let vals = await this.ctx.api().query.cash.validators.entries();
    const authData = vals.map(([valIdRaw, chainKeys]) =>
      [
        this.toSS58(valIdRaw.args[0]),
        {eth_address: this.toEthAddress(chainKeys.unwrap().eth_address)}
      ]
    );
    return authData;
  }

  async sessionValidators() {
    let vals = await this.ctx.api().query.session.validators();
    return vals.map((valIdRaw) => this.toSS58(valIdRaw));
  }

  async getGrandpaAuthorities() {
    const grandpaStorageKey = ':grandpa_authorities';
    const grandpaAuthorities = await this.ctx.api().rpc.state.getStorage(grandpaStorageKey);
    const auths = this.ctx.api().createType('VersionedAuthorityList', grandpaAuthorities.value).authorityList;
    return auths.map(e => this.toSS58(e[0]));
  }

  async getAuraAuthorites() {
    const auraAuthStorageKey = this.getStorageKey("Aura", "Authorities");
    const rawAuths = await this.ctx.api().rpc.state.getStorage(auraAuthStorageKey);
    const auths = this.ctx.api().createType('Authorities', rawAuths.value);
    return auths.map(e => this.ctx.actors.keyring.encodeAddress(e));
  }

  async rotateKeys(validator) {
    const keysRaw = await validator.api.rpc.author.rotateKeys();
    return this.ctx.api().createType('SessionKeys', keysRaw);
  }

  async setKeys(signer, keys) {
    const call = this.ctx.api().tx.session.setKeys(keys, "0x5566");
    await this.ctx.eventTracker.sendAndWaitForEvents(call, { signer });
  }

  async waitUntilSession(target, retries = 60) {
    const timer = ms => new Promise(res => setTimeout(res, ms));
    const checkIdx = async (r) => {
      const idx = (await this.ctx.api().query.session.currentIndex()).toNumber();
      if (idx < target) {
        this.ctx.log(`Waiting for session=${target}, curr=${idx}`);

        if (r === 0) {
          throw new Error(`Unable to get session ${target} after ${retries} retries`);
        } else {
          await timer(1000);
          await checkIdx(r - 1);
        }
      }
    };
    await checkIdx(retries);
  }
}


function buildChain(ctx) {
  return new Chain(ctx);
}

module.exports = {
  buildChain,
  Chain
};
