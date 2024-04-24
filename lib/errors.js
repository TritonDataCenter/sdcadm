/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 * Copyright 2024 MNX Cloud, Inc.
 */

/*
 * Error classes that sdcadm may produce.
 */

var util = require('util');
var format = util.format;
var assert = require('assert-plus');
var verror = require('verror');
var WError = verror.WError;


// ---- error classes

/**
 * Base sdcadm error. Instances will always have a string `message` and
 * a string `code` (a CamelCase string).
 *
 * Additionally, if the error info field contains a property named `showErr`
 * it will be used to display or not the error message (using `console.log`)
 * right before program exit. (Note error messages will be displayed by
 * default if nothing else is specified).
 */
function SdcAdmError(options) {
    assert.object(options, 'options');
    assert.string(options.message, 'options.message');
    assert.string(options.code, 'options.code');
    assert.optionalObject(options.cause, 'options.cause');
    assert.optionalNumber(options.statusCode, 'options.statusCode');
    var self = this;

    var args = [];
    if (options.cause) {
        args.push(options.cause);
    }
    args.push('%s');
    args.push(options.message);
    WError.apply(this, args);

    var extra = Object.keys(options).filter(function (k) {
        return ['cause', 'message'].indexOf(k) === -1;
    });
    extra.forEach(function (k) {
        self[k] = options[k];
    });
}
util.inherits(SdcAdmError, WError);

/**
 * Usage:
 *      new errors.InternalError({
 *          message: '...',
 *          cause: <error instance>   // optional
 *      });
 *
 * or just pass in a cause (cause.message will be used for `message`):
 *      new errors.InternalError(<error instance>);
 */
function InternalError(options) {
    if (options instanceof Error) {
        // Alternative call signature: `new InternalError(<Error instance>)`.
        options = {
            message: options.message,
            cause: options
        };
    }

    assert.object(options, 'options');
    assert.optionalObject(options.cause, 'options.cause');
    assert.string(options.message, 'options.message');
    options.code = 'InternalError';
    options.exitStatus = 1;
    SdcAdmError.call(this, options);
}
util.inherits(InternalError, SdcAdmError);

function UsageError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcAdmError.call(this, {
        cause: cause,
        message: message,
        code: 'Usage',
        exitStatus: 2
    });
}
util.inherits(UsageError, SdcAdmError);

function UpdateError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcAdmError.call(this, {
        cause: cause,
        message: message,
        code: 'Update',
        exitStatus: 2
    });
}
util.inherits(UpdateError, SdcAdmError);

function InstanceIsDownError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcAdmError.call(this, {
        cause: cause,
        message: message,
        code: 'InstanceIsDown',
        exitStatus: 2
    });
}
util.inherits(InstanceIsDownError, SdcAdmError);

function ValidationError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcAdmError.call(this, {
        cause: cause,
        message: message,
        code: 'Validation',
        exitStatus: 2
    });
}
util.inherits(ValidationError, SdcAdmError);

/**
 * An error to wrap around node-sdc-clients API errors.
 * This *prefers* they are following:
 *      https://github.com/TritonDataCenter/eng/blob/master/docs/index.md#error-handling
 * but we have enough exceptions, even in APIs like IMGAPI that try hard
 * that we need to be defensive.
 */
function SDCClientError(cause, clientName) {
    assert.object(cause, 'cause');
    assert.optionalObject(cause.body, 'cause.body');
    var body = cause.body || {message: cause.message || cause.toString()};
    assert.optionalString(body.code, 'cause.body.code');
    assert.optionalString(body.message, 'cause.body.message');
    assert.string(clientName, 'clientName');

    var codeExtra = (body.code ? ' (' + body.code + ')' : '');
    var msg = body.message || cause.message || cause.toString();
    if (body.errors) {
        body.errors.forEach(function (e) {
            msg += format('\n    %s: %s', e.field, e.code);
            if (e.message) {
                msg += ': ' + e.message;
            }
        });
    }
    SdcAdmError.call(this, {
        cause: cause,
        message: format('%s client error%s: %s', clientName, codeExtra, msg),
        code: 'SDCClient',
        exitStatus: 1
    });
}
SDCClientError.description = 'An error from an API client.';
util.inherits(SDCClientError, SdcAdmError);

/**
 * Multiple errors in a group.
 *
 * Dev Note: If/when sdcadm revisits its error class heirarchy, this class
 * should be dropped in favour of verror.MultiError.
 */
function MultiError(errs) {
    assert.arrayOfObject(errs, 'errs');
    var lines = [format('multiple (%d) errors', errs.length)];
    for (var i = 0; i < errs.length; i++) {
        var err = errs[i];
        if (err.code) {
            lines.push(format('    error (%s): %s', err.code, err.message));
        } else {
            lines.push(format('    error: %s', err.message));
        }
    }
    SdcAdmError.call(this, {
        cause: errs[0],
        message: lines.join('\n'),
        code: 'MultiError',
        exitStatus: 1
    });
}
MultiError.description = 'Multiple errors.';
util.inherits(MultiError, SdcAdmError);



// ---- exports


/**
 * Use this as a convenience shortcut to wrap a callback to a node-sdc-client.
 * Any returned error will be wrapped in `SDCClientError`.
 */
function sdcClientErrWrap(cb, clientName) {
    return function sdcClientCb() {
        var args = Array.prototype.slice.call(arguments);
        if (args[0]) {
            args[0] = new SDCClientError(args[0], clientName);
        }
        cb.apply(null, args);
    };
}

/**
 * Return true if the given `err` has a `.errors` including the given error
 * code.
 *
 * See <https://github.com/TritonDataCenter/eng/blob/master/docs/index.md#error-handling>
 * for details on the "errors" array.
 */
function haveErrCode(err, code) {
    var hits = (err.body && err.body.errors || []).filter(
        function (e) { return e.code === code; });
    return (hits.length > 0);
}


module.exports = {
    SdcAdmError: SdcAdmError,
    InternalError: InternalError,
    UsageError: UsageError,
    UpdateError: UpdateError,
    InstanceIsDownError: InstanceIsDownError,
    ValidationError: ValidationError,
    SDCClientError: SDCClientError,
    MultiError: MultiError,

    sdcClientErrWrap: sdcClientErrWrap,
    haveErrCode: haveErrCode
};
// vim: set softtabstop=4 shiftwidth=4:
