/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_extsprintf = require('extsprintf');

var lib_common = require('../common');
var lib_ur = require('../ur');
var lib_errors = require('../errors');

var sprintf = mod_extsprintf.sprintf;
var VError = mod_verror.VError;


var CMD_VMADM = '/usr/sbin/vmadm';

var LEVEL_SERVICE = 'service';
var LEVEL_VM = 'vm';

/*
 * These parameters are only valid on the SAPI service, and simply need to
 * be updated if they are incorrect.
 */
var SERVICE_LEVEL_STRINGS = [
    'package_name'
];

/*
 * These parameters are valid at both the SAPI service and the VM level.  If
 * the current configured value is less than the desired new value, we will
 * replace the configured value.  Otherwise, if the configured value is already
 * larger, we will do nothing.
 */
var ALL_LEVEL_INCREASE_NUMBERS = [
    'max_physical_memory',
    'max_locked_memory',
    'max_swap',
    'max_lwps',
    'zfs_io_priority',
    'cpu_cap'
];

function determineChanges(currentValues, newValues, level) {
    mod_assert.object(currentValues, 'currentValues');
    mod_assert.object(newValues, 'newValues');
    mod_assert.string(level, 'level');
    mod_assert.ok(level === LEVEL_SERVICE || level === LEVEL_VM);

    /*
     * We want to return a list of update messages to display to the operator
     * via progress(), a list of arguments to pass to vmadm(1M), and a "params"
     * object to pass to SAPI UpdateService.
     */
    var changes = {
        chg_progress: [],
        chg_args: [],
        chg_params: {}
    };

    Object.keys(newValues).forEach(function (name) {
        var current = currentValues[name];
        var updated = newValues[name];

        if (SERVICE_LEVEL_STRINGS.indexOf(name) !== -1) {
            if (level !== LEVEL_SERVICE) {
                /*
                 * This is a service-level parameter, but we are not dealing
                 * with a service at this time.
                 */
                return;
            }

            mod_assert.string(updated);
            if (current !== updated) {
                changes.chg_progress.push(sprintf('%s: %s -> %s', name,
                    current ? current : '<none>', updated));
                changes.chg_args.push(sprintf('%s=%s', name, updated));
                changes.chg_params[name] = updated;
            }
            return;
        }

        if (ALL_LEVEL_INCREASE_NUMBERS.indexOf(name) !== -1) {
            mod_assert.number(updated);
            mod_assert.optionalNumber(current);

            /*
             * If the current value exists and is at least as large as the
             * desired updated value, we need not do anything.
             */
            if (current && current >= updated) {
                return;
            }

            if (!current) {
                changes.chg_progress.push(sprintf('%s: <none> -> %d', name,
                    updated));
            } else {
                changes.chg_progress.push(sprintf('%s: %d -> %d', name,
                    current, updated));
            }
            changes.chg_args.push(sprintf('%s=%d', name, updated));
            changes.chg_params[name] = updated;
            return;
        }

        throw (VError('unexpected parameter name "%s"', name));
    });

    return (changes);
}

function updateSizeParametersVM(usp, vm, next) {
    mod_assert.func(usp.usp_progress);
    var progress = usp.usp_progress;

    var chg = determineChanges(vm, usp.usp_newValues, LEVEL_VM);

    if (chg.chg_progress.length < 1) {
        usp.usp_log.debug('%s is up-to-date', vm.alias);
        setImmediate(next);
        return;
    }

    progress('Updating size parameters for %s VM', usp.usp_serviceName);
    progress(lib_common.indent(sprintf('alias: %s', vm.alias), 4));
    progress(lib_common.indent(sprintf('vm uuid: %s', vm.uuid), 4));
    progress(lib_common.indent(sprintf('server uuid: %s', vm.server_uuid), 4));
    progress(lib_common.indent(chg.chg_progress.join('\n'), 8));

    /*
     * Construct a vmadm(1M) command that will update the desired
     * properties on this VM and execute it on the correct server.
     */
    lib_ur.exec({
        cmd: sprintf('%s update %s %s', CMD_VMADM, vm.uuid,
            chg.chg_args.join(' ')),
        sdcadm: usp.usp_sdcadm,
        server: vm.server_uuid,
        log: usp.usp_log
    }, next);
}

function updateSizeParametersVMs(usp, next) {
    /*
     * Apply the parameter update to all VMs that represent an instance of this
     * service:
     */
    usp.usp_sdcadm.vmapi.listVms({
        'tag.smartdc_role': usp.usp_serviceName,
        state: 'running'
    }, function (err, vms) {
        if (err) {
            next(err);
            return;
        }

        mod_vasync.forEachPipeline({
            inputs: vms,
            func: function (vm, _next) {
                updateSizeParametersVM(usp, vm, _next);
            }
        }, next);
    });
}

function updateSizeParametersService(usp, next) {
    mod_assert.func(usp.usp_progress);
    var progress = usp.usp_progress;

    var chg = determineChanges(usp.usp_currentValues, usp.usp_newValues,
        LEVEL_SERVICE);

    if (chg.chg_progress.length < 1) {
        usp.usp_log.debug('SAPI service "%s" values are up-to-date',
            usp.usp_serviceName);
        setImmediate(next);
        return;
    }

    progress('Updating size parameters for %s SAPI service',
        usp.usp_serviceName);
    progress(lib_common.indent(sprintf('service uuid: %s',
        usp.usp_serviceUuid)));
    progress(lib_common.indent(chg.chg_progress.join('\n'), 8));

    usp.usp_sdcadm.sapi.updateService(usp.usp_serviceUuid, {
        params: chg.chg_params
    }, function (err, svc) {
        if (err) {
            next(new lib_errors.SDCClientError(err, 'sapi'));
            return;
        }

        next();
    });
}

/*
 * Update some set of size parameters in a SAPI service, as well as the
 * live configuration of any VMs that represent an instance of that service.
 */
function updateSizeParameters(opts, callback) {
    lib_common.assertStrictOptions('updateSizeParameters', opts, {
        progress: 'func',
        params: 'object',
        service: 'object',
        log: 'object',
        sdcadm: 'object'
    });
    mod_assert.uuid(opts.service.uuid, 'service.uuid');
    mod_assert.string(opts.service.name, 'service.name');
    mod_assert.func(callback, 'callback');

    mod_vasync.pipeline({
        arg: {
            usp_log: opts.log,
            usp_progress: opts.progress,
            usp_sdcadm: opts.sdcadm,

            usp_serviceName: opts.service.name,
            usp_serviceUuid: opts.service.uuid,
            usp_currentValues: opts.service.params,
            usp_newValues: opts.params

        }, funcs: [
            updateSizeParametersService,
            updateSizeParametersVMs
        ]
    }, callback);
}

module.exports = {
    updateSizeParameters: updateSizeParameters
};
/* vim: set ts=4 sts=4 sw=4 et: */
