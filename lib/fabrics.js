/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Logic to deal with the set up and manipulation of fabrics and fabric related
 * options.
 */

var fs = require('fs');
var errors = require('./errors');
var schemas = require('joyent-schemas');
var vasync = require('vasync');
var jsprim = require('jsprim');
var sprintf = require('extsprintf').sprintf;
var assert = require('assert-plus');

var fabInitHelp = 'Initialize fabrics in the datacenter.\n' +
    '\n' +
    'Usage: {{name}} fabrics [-c conf] [-f] [-h]\n' +
    '\n' +
    '{{options}}';

var fabInitOpts = [ {
    names: [ 'conf', 'c' ],
    type: 'string',
    help: 'Use configuration information instead of prompting',
    helpArg: 'FILE'
}, {
    names: [ 'force', 'f' ],
    type: 'bool',
    help: 'force an update, even if fabric configuration already exists'
}, {
    names: [ 'help', 'h' ],
    type: 'bool',
    help: 'Display this help message'
} ];

/*
 * Distinguish between ENOENT and other errors for user sanity.  The way our
 * APIs are designed, this can come back to us in two different flavors. If a
 * URI parameter doesn't match some parameter, then we're going to get a 422
 * with an InvalidParameters error code. If it was a valid URI scheme, but it
 * doesn't exist, then we get a 404. If we're in the InvalidParameters case, we
 * make sure that it matches the part of the URI parameter that we expect,
 * otherwise we consider it an error that the user is not responsible for, eg.
 * say NAPI was down, or there was a programmer error.
 *
 * A friendly reminder, the error object that the API returns is wrapped up
 * slightly. The original error object that you'd see from hitting the API
 * directly is actually inside err.body and instead of err.code you want
 * err.restCode.
 */
function napiUserError(err, field) {
    if (err.restCode !== 'InvalidParameters' &&
        err.restCode !== 'ResourceNotFound') {
        return false;
    }

    if (err.restCode === 'InvalidParameters' &&
        (err.body.errors.length > 1 ||
        err.body.errors[0].field !== field)) {
        return false;
    }

    return true;
}

function fabInitDiffSchema(opts, cb) {
    var schema = schemas.sdc.sdc_app;
    var fab, mdata;

    assert.object(opts.sapiApp);

    if ('metadata_schemas' in opts.sapiApp &&
        'properties' in opts.sapiApp.metadata_schemas &&
        'fabric_cfg' in opts.sapiApp.metadata_schemas.properties) {
        mdata = opts.sapiApp.metadata_schemas;
        fab = mdata.properties.fabric_cfg;
        if (jsprim.deepEqual(fab, schema.properties.fabric_cfg)) {
             return cb(null);
        }
    }

    opts.sdcadm.sapi.updateApplication(opts.sapiApp.uuid, {
        action: 'update',
        metadata_schema: schema
    }, function (err, app) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'sapi'));
        }
        opts.sapiApp = app;
        return cb(null);
    });
}

/*
 * If SAPI metadata for fabric_cfg exists, require that the force flag bet set.
 */
function fabInitCheckForce(opts, cb) {

    assert.object(opts.sapiApp);

    if (!('metadata' in opts.sapiApp)) {
        return cb(null);
    }

    if (!('fabric_cfg' in opts.sapiApp.metadata)) {
        return cb(null);
    }

    if (opts.force) {
        return cb(null);
    }

    return cb(new errors.ValidationError('fabric configuration already ' +
        'exists and -f was not specified, aborting'));
}

/*
 * Read all configuration from a specified file.
 */
function fabInitConf(opts, cb) {
    fs.readFile(opts.conf, { format: 'utf8' }, function (err, data) {
        if (err) {
            return cb(new errors.ValidationError(err,
                sprintf('failed to read %s: %s', opts.conf, err.message)));
        }
        try {
            data = JSON.parse(data);
        } catch (e) {
            return cb(new errors.ValidationError(e,
                sprintf('%s in not a valid JSON file', opts.conf)));
        }
        opts.data = data;
        cb(null);
    });
}

/*
 * First validate the schema
 */
function fabInitCheckSchema(opts, cb) {
    var ret;
    var schema = schemas.sdc.sdc_app;

    assert.object(opts.data);
    ret = jsprim.validateJsonObject(schema.properties.fabric_cfg,
        opts.data);
    if (ret !== null) {
         return cb(new errors.ValidationError(ret,
             sprintf('invalid fabric configuration: %s', ret)));
    }

    cb(null);
}

function fabInitCheckTags(opts, cb) {
    assert.object(opts.data);
    opts.sdcadm.napi.getNicTag(opts.data.sdc_underlay_tag,
        function (err, tag) {
        if (err) {
            if (napiUserError(err, 'name')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find nic tag: %s, it ' +
                        'either does not exist or is invalid',
                    opts.data.sdc_underlay_tag)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }
        return cb(null);
    });
}

/*
 * If the user has opted for automatic assignment, then we need to make sure
 * that the network pool they've given us is valid.  Which means that it has to
 * be a valid pool (or network) and its nic tag must be the underlay tag
 * specified.
 */
function fabInitCheckAssignment(opts, cb) {
    assert.object(opts.data);
    if (opts.data.sdc_underlay_assignment === 'manual') {
        if ('sdc_underlay_pool' in opts.data) {
            return cb(new errors.ValidationError('cannot specify ' +
                '"sdc_underlay_pool" when "sdc_underlay_assignment"' +
                'is set to "manual"'));
        }
        return cb(null);
    }

    opts.sdcadm.napi.getNetworkPool(opts.data.sdc_underlay_pool,
        function (err, pool) {
        if (err) {
            if (napiUserError(err, 'uuid')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find resource pool: %s, it ' +
                        'either does not exist or is invalid',
                    opts.data.sdc_underlay_pool)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }

        /* All networks on a pool should have the same tag */
        opts.sdcadm.napi.getNetwork(pool.networks[0],
            function (neterr, net) {
            if (neterr) {
                return cb(new errors.SDCClientError(neterr, 'napi'));
            }
            if (net.nic_tag !== opts.data.sdc_underly_tag) {
                return cb(new errors.ValidationError(sprintf('specified ' +
                    'network pool %s has nic tag %s, which does not ' +
                    'match fabric configuration "sdc_underlay_tag": %s',
                    opts.data.sdc_underlay_pool,
                    net.nic_tag,
                    opts.data.sdc_underlay_tag)));
            }
            return cb(null);
        });
    });
}

/*
 * Check that the external network pool for NAT zones exists.
 */
function fabCheckNatPool(opts, cb) {
    assert.object(opts.data);

    opts.sdcadm.napi.getNetworkPool(opts.data.sdc_nat_pool,
            function (err, pool) {
        if (err) {
            if (napiUserError(err, 'uuid')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find NAT network pool: %s, it ' +
                        'either does not exist or is invalid',
                    opts.data.sdc_nat_pool)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }

        return cb(null);
    });
}

function fabInitUpdate(opts, cb) {
    assert.object(opts.data);

    /*
     * Note, we're updating the entire application here, but update today only
     * ever goes one layer deep. eg. update will always replace our key,
     * 'fabric_cfg', with one that's always what we give it. In this case, it
     * shouldn't merge anything. If that behavior changes, we're in trouble and
     * the docs don't exactly promise one behavior or another...
     */
    opts.sdcadm.sapi.updateApplication(opts.sapiApp.uuid, {
        action: 'update',
        metadata: { fabric_cfg: opts.data }
    }, errors.sdcClientErrWrap(cb, 'sapi'));
}

function fabInitFunc(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help === true) {
        this.do_help('help', {}, [ subcmd ], cb);
        return;
    }
    if (args.length !== 0) {
        return cb(new errors.UsageError('Extraneous arguments: ' +
            args.join(' ')));
    }
    if (opts.conf === undefined) {
        return cb(new errors.UsageError('-c is required'));
    }

    var pipeargs = {
        sdcadm: this.sdcadm,
        sapiApp: this.sdcadm.sdc,
        conf: opts.conf,
        force: opts.force
    };

    /*
     * Pipeline stages:
     *
     * 1. check schema, if not set, set schema
     * 2. check if set up already, if yes, error
     * 3. get configuration
     * 4. check config against local schema
     * 5. set that configuration
     */
    vasync.pipeline({ funcs: [ fabInitDiffSchema,
        fabInitCheckForce, fabInitConf, fabInitCheckSchema,
        fabInitCheckTags, fabInitCheckAssignment, fabCheckNatPool,
        fabInitUpdate ],
        arg: pipeargs },
        function (err, results) {
            if (err) {
                return cb(err);
            }
            self.progress('Successfully initialized fabric sub-system');
    });
}

fabInitFunc.help = fabInitHelp;
fabInitFunc.options = fabInitOpts;


module.exports = {
    fabInit: fabInitFunc
};
