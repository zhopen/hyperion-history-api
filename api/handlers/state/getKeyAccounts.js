const {getKeyAccountsSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const numeric = require('eosjs/dist/eosjs-numeric');

function invalidKey() {
    const err = new Error();
    err.statusCode = 400;
    err.message = 'invalid public key';
    throw err;
}

async function getKeyAccounts(fastify, public_Key) {

    const {redis, elastic} = fastify;
    let publicKey;

    if (public_Key.startsWith("PUB_")) {
        publicKey = public_Key;
    } else if (public_Key.startsWith("EOS")) {
        try {
            publicKey = numeric.convertLegacyPublicKey(public_Key);
        } catch (e) {
            console.log(e);
            invalidKey();
        }
    } else {
        invalidKey();
    }

    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(publicKey));
    if (cachedResponse) {
        return cachedResponse;
    }
    const _body = {
        query: {
            bool: {
                should: [
                    {term: {"@updateauth.auth.keys.key.keyword": publicKey}},
                    {term: {"@newaccount.active.keys.key.keyword": publicKey}},
                    {term: {"@newaccount.owner.keys.key.keyword": publicKey}}
                ],
                minimum_should_match: 1
            }
        },
        sort: [{"global_sequence": {"order": "desc"}}]
    };

    const results = await elastic.search({
        index: process.env.CHAIN + '-action-*',
        body: _body
    });

    const response = {
        account_names: []
    };
    if (results['body']['hits']['hits'].length > 0) {
        response.account_names = results['body']['hits']['hits'].map((v) => {
            if (v._source.act.name === 'newaccount') {
                if (v._source['@newaccount'].newact) {
                    return v._source['@newaccount'].newact;
                } else if (v._source.act.data.newact) {
                    return v._source.act.data.newact;
                } else {
                    return null;
                }
            } else if (v._source.act.name === 'updateauth') {
                return v._source.act.data.account;
            } else {
                return null;
            }
        });
    }
    if (response.account_names.length > 0) {
        response.account_names = [...(new Set(response.account_names))];
        redis.set(hash, JSON.stringify(response), 'EX', 30);
        return response;
    } else {
        const err = new Error();
        err.statusCode = 404;
        err.message = 'no accounts associated with ' + public_Key;
        throw err;
    }
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_key_accounts', {
        schema: getKeyAccountsSchema.GET
    }, async (request) => {
        return getKeyAccounts(fastify, request.query.public_key);
    });
    fastify.post('/get_key_accounts', {
        schema: getKeyAccountsSchema.POST
    }, async (request) => {
        return getKeyAccounts(fastify, request.body.public_key);
    });
    next();
};
