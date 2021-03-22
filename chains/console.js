const fs = require('fs').promises;
const repl = require('repl');
const path = require('path');
const { Readable } = require('stream');
const { createReadStream } = require('fs');
const getopts = require('getopts');
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const fetch = require('node-fetch');
const { getSaddle, describeProvider } = require('eth-saddle');

function matchesLine(completion, line) {
  if (completion.initial && line.startsWith(completion.initial)) {
    return true;
  }

  return false;
}

function targetMatches(completion, line) {
  let words = line.split(/\s+/);
  let position = words.length - 1; // e.g. "deploy" = 0 "deploy " = 1 "deploy abc" = 1
  let lastWord = words.length === 0 ? "" : words[words.length - 1];
  let targets = completion.targets.filter(({pos}) => pos === position);

  let matching = targets.reduce((acc, {choices}) => {
    return [
      ...acc,
      ...choices.filter((choice) => choice.startsWith(lastWord))
    ];
  }, []);

  if (lastWord.length > 0) {
    return [matching, lastWord];
  } else {
    return [matching, line];
  }
}

function getCompleter(defaultCompleter, completions) {
  return function(line, callback) {
    const lineMatches = completions.filter((completion) => matchesLine(completion, line));
    let [choices, text] = lineMatches.reduce(([accMatch, accText], completion) => {
      let [matches, text] = targetMatches(completion, line);

      if (matches && text.length < accText.length) {
        return [matches, text];
      } else if (matches && text.length === accText.length) {
        return [ [ ...accMatch, ...matches ], accText];
      } else {
        return [accMatch, accText];
      }
    }, [[], line]);

    if (choices.length > 0) {
      callback(null, [choices, text]);
    } else {
      defaultCompleter(line, callback);
    }
  }
}

function getCompletions(defaultCompleter, contracts) {
  let contractNames = Object.keys(contracts)
  let contractAddresses = Object.values(contracts).filter((x) => !!x);

  const completions = [
    {
      initial: '.deploy',
      targets: [
        {
          pos: 1,
          choices: contractNames
        }
      ]
    },
    {
      initial: '.match',
      targets: [
        {
          pos: 1,
          choices: contractAddresses
        },
        {
          pos: 2,
          choices: contractNames
        }
      ]
    }
  ];

  return getCompleter(defaultCompleter, completions);
}

function lowerCase(str) {
  if (str === "") {
    return "";
  } else {
    return str[0].toLowerCase() + str.slice(1,);
  }
}

async function wrapError(fn, r) {
  try {
    return await fn;
  } catch (err) {
    console.error(`Error: ${err}`);
  } finally {
    r.displayPrompt();
  }
}

async function getContracts(saddle) {
  let contracts = await saddle.listContracts();
  let contractInsts = await Object.entries(contracts).reduce(async (acc, [contract, address]) => {
    if (address) {
      return {
        ... await acc,
        [contract]: await saddle.getContractAt(contract, address)
      };
    } else {
      return await acc;
    }
  }, {});

  return {
    contracts,
    contractInsts
  };
}

function defineAction(r, fn) {
  return async (name) => {
    r.clearBufferedCommand();
    await wrapError(fn(), r);
  };
}

function defineCommands(r, { api, keyring }, saddle, network, contracts) {
  r.defineCommand('validators', {
    help: 'Show current validators',
    action: defineAction(r, async () => {
      let validators = await api.query.cash.validators.entries();
      validators.forEach(([substrateId, validatorKeys]) => {
        let key = toSS58(keyring, substrateId.toHuman()[0]);
        let value = Object.entries(validatorKeys.unwrap().toJSON()).map(([k, v]) =>
          `\t\t${k}=${v}`).join("\n");
        console.log(`\t${key}:\n${value}\n`);
      });
    })
  });

  r.defineCommand('block', {
    help: 'Show current gateway block',
    action: defineAction(r, async () => {
      const blockHash = await api.rpc.chain.getBlockHash();
      const signedBlock = await api.rpc.chain.getBlock(blockHash);
      let header = signedBlock.block.header;
      console.log(`#${header.number}`);
    })
  });

  r.defineCommand('eth_network', {
    help: 'Show given Ethereum network',
    action: defineAction(r, async () => {
      console.log(`Network: ${network}`);
    })
  });

  r.defineCommand('eth_from', {
    help: 'Show default from Ethereum address',
    action: defineAction(r, async () => {
      console.log(`From: ${saddle.network_config.default_account}`);
    })
  });

  r.defineCommand('eth_deployed', {
    help: 'Show given deployed Ethereum contracts',
    action: defineAction(r, async () => {
      Object.entries(contracts).forEach(([contract, deployed]) => {
        console.log(`${contract}: ${deployed || ""}`);
      });
    })
  });
}

function defineContracts(r, saddle, contractInsts) {
  Object.entries(contractInsts).forEach(([contract, contractInst]) => {
    Object.defineProperty(r.context, lowerCase(contract), {
      configurable: true,
      enumerable: true,
      value: contractInst
    });
  });
}

async function loadChainConfig(chain) {
  return JSON.parse(await fs.readFile(path.join(__dirname, chain, 'chain-config.json'), 'utf8'));
}

async function loadTypes(version) {
  return JSON.parse(await fs.readFile(path.join(__dirname, '..', 'releases', `m${Number(version)}`, 'types.json'), 'utf8'));
}

async function rpc(chain, chainConfig, section, method, params=[]) {
  if (!chainConfig.rpc) {
    throw new Error(`No websocket config for chain ${chain}`);
  }

  let res = await fetch(chainConfig.rpc, {
    method: 'post',
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: `${section}_${method}`,
      params
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  let resJson = await res.json();

  return resJson.result;
}

async function getRuntimeVersion(chain, chainConfig) {
  return await rpc(chain, chainConfig, "state", "getRuntimeVersion");
}

function toSS58(keyring, arr) {
  return keyring.encodeAddress(arr);
}

async function connect(chain, chainConfig) {
  if (!chainConfig.websocket) {
    throw new Error(`No websocket config for chain ${chain}`);
  }

  let runtimeVersion = await getRuntimeVersion(chain, chainConfig);
  let { specVersion } = runtimeVersion;
  let typesJson = await loadTypes(specVersion);

  const wsProvider = new WsProvider(chainConfig.websocket);
  let api = await ApiPromise.create({
    provider: wsProvider,
    types: typesJson
  });

  let keyring = new Keyring();
  let types = api.types;

  return {
    wsProvider,
    api,
    keyring,
    types
  };
}

function defineKeys(r, obj) {
  Object.entries(obj).forEach(([key, value]) => {
    Object.defineProperty(r.context, key, {
      configurable: false,
      enumerable: typeof(value) !== 'function',
      value
    });
  });
}

async function startConsole(input, chain, trace) {
  let chainConfig = await loadChainConfig(chain);
  let connection = await connect(chain, chainConfig);
  let network = chainConfig.eth_network;
  let saddle = await getSaddle(network);
  let {contracts, contractInsts} = await getContracts(saddle);

  console.info(`Gateway console on chain ${chain}`);

  Object.entries(contracts).forEach(([contract, deployed]) => {
    if (deployed) {
      console.log(`\t${lowerCase(contract)}: ${deployed}`);
    }
  });

  let r = repl.start({
    prompt: '> ',
    input: input,
    output: input ? process.stdout : undefined,
    terminal: input ? false : undefined
  });
  if (typeof(r.setupHistory) === 'function') {
    r.setupHistory(path.join(process.cwd(), '.gateway_history'), (err, repl) => null);
  }
  r.originalCompleter = r.completer;
  r.completer = getCompletions(r.completer, contracts);

  defineCommands(r, connection, saddle, network, contracts);

  defineKeys(r, { saddle });
  defineKeys(r, connection);
  defineContracts(r, saddle, contractInsts);

  process.on('uncaughtException', () => console.log('Error'));

  r.on('exit', () => {
    process.exit();
  });
}

let input;
const options = getopts(process.argv.slice(2), {
  alias: {
    script: "s",
    eval: "e",
    chain: "c"
  },
});

if (!options.chain) {
  throw new Error(`Must choose chain with -c`);
}

if (options.script) {
  input = createReadStream(options.script);
} else if (options.eval) {
  let evalArg = options.eval;
  let codes = Array.isArray(evalArg) ? evalArg.map((e) => e + ';\n') : [ evalArg ];
  input = Readable.from(codes);
}

startConsole(input, options.chain, process.env['TRACE']);
