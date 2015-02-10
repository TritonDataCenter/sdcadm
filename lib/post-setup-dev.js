/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The set of 'sdcadm post-setup dev-*' commands.
 */

var assert = require('assert-plus');
var format = require('util').format;
var vasync = require('vasync');

var errors = require('./errors');



//---- globals

var p = console.log;



//---- sdcadm post-setup dev-headnode-prov

function makeHeadnodeProvisionable(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');

    var sdcadm = opts.sdcadm;

    vasync.pipeline({arg: {}, funcs: [
        function getCnapiSvc(ctx, next) {
            sdcadm.getSvc({app: 'sdc', svc: 'cnapi'}, function (err, cnapi) {
                if (err) {
                    return next(err);
                }
                ctx.cnapi = cnapi;
                next();
            });
        },
        function tweakCnapiConfig(ctx, next) {
            if (ctx.cnapi.metadata.ALLOC_FILTER_HEADNODE === false &&
                ctx.cnapi.metadata.ALLOC_FILTER_MIN_RESOURCES === false)
            {
                opts.progress('CNAPI is already configured to allow headnode ' +
                    'provisioning and over-provisioning');
                return next();
            }

            opts.progress('Configuring CNAPI to allow headnode provisioning' +
                ' and over-provisioning (allow a minute to propagate)');
            var update = {
                metadata: {
                    ALLOC_FILTER_HEADNODE: false,
                    ALLOC_FILTER_MIN_RESOURCES: false
                }
            };
            sdcadm.sapi.updateService(ctx.cnapi.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        }
    ]}, cb);
}


function HeadnodeProvCLI(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    makeHeadnodeProvisionable({
        sdcadm: this.sdcadm,
        log: this.log.child({postSetup: 'dev-headnode-prov'}, true),
        progress: this.top.progress
    }, cb);
}

HeadnodeProvCLI.help = (
    /* BEGIN JSSTYLED */
    'Make the headnode provisionable, for development and testing.\n' +
    '\n' +
    'This is done via `ALLOC_FILTER_HEADNODE` and `ALLOC_FILTER_MIN_RESOURCES`\n' +
    'SAPI configuration of the CNAPI service. See\n' +
    '    https://github.com/joyent/sdc-cnapi/blob/master/docs/index.md#sapi-configuration\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} dev-headnode-prov\n'
    /* END JSSTYLED */
);

HeadnodeProvCLI.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];



//---- PostSetup CLI class


//---- exports

module.exports = {
    HeadnodeProvCLI: HeadnodeProvCLI
};
