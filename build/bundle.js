(function loader(mappings, entryPoints, options) {

  if (entryPoints.length > 1) {
    throw new Error(
      "LiveReactLoad supports only one entry point at the moment"
    )
  }

  var entryId = entryPoints[0];

  var scope = {
    mappings: mappings,
    cache: {},
    reloading: false,
    reloadHooks: {},
    reload: function (fn) {
      scope.reloading = true;
      try {
        fn();
      } finally {
        scope.reloading = false;
      }
    }
  };


  function startClient() {
    if (!options.clientEnabled) {
      return;
    }
    if (typeof window.WebSocket === "undefined") {
      warn("WebSocket API not available, reloading is disabled");
      return;
    }
    var protocol = window.location.protocol === "https:" ? "wss" : "ws";
    var url = protocol + "://" + (options.host || window.location.hostname);
    if (options.port != 80) {
      url = url + ":" + options.port;
    }
    var ws = new WebSocket(url);
    ws.onopen = function () {
      info("WebSocket client listening for changes...");
    };
    ws.onmessage = function (m) {
      var msg = JSON.parse(m.data);
      if (msg.type === "change") {
        handleBundleChange(msg.data);
      } else if (msg.type === "bundle_error") {
        handleBundleError(msg.data);
      }
    }
  }

  function compile(mapping) {
    var body = mapping[0];
    if (typeof body !== "function") {
      debug("Compiling module", mapping[2])
      var compiled = compileModule(body, mapping[2].sourcemap);
      mapping[0] = compiled;
      mapping[2].source = body;
    }
  }

  function compileModule(source, sourcemap) {
    var toModule = new Function(
      "__livereactload_source", "__livereactload_sourcemap",
      "return eval('function __livereactload_module(require, module, exports){\\n' + __livereactload_source + '\\n}; __livereactload_module;' + (__livereactload_sourcemap || ''));"
    );
    return toModule(source, sourcemap)
  }

  function unknownUseCase() {
    throw new Error(
      "Unknown use-case encountered! Please raise an issue: " +
      "https://github.com/milankinen/livereactload/issues"
    )
  }

  // returns loaded module from cache or if not found, then
  // loads it from the source and caches it
  function load(id, recur) {
    var mappings = scope.mappings;
    var cache = scope.cache;

    if (!cache[id]) {
      if (!mappings[id]) {
        var req = typeof require == "function" && require;
        if (req) return req(id);
        var error = new Error("Cannot find module '" + id + "'");
        error.code = "MODULE_NOT_FOUND";
        throw error;
      }

      var hook = scope.reloadHooks[id];
      var module = cache[id] = {
        exports: {},
        __accepted: false,
        onReload: function (hook) {
          scope.reloadHooks[id] = hook;
        }
      };

      mappings[id][0].call(module.exports, function require(path) {
        var targetId = mappings[id][1][path];
        return load(targetId ? targetId : path);
      }, module, module.exports, unknownUseCase, mappings, cache, entryPoints);

      if (scope.reloading && typeof hook === "function") {
        // it's important **not** to assign to module.__accepted because it would point
        // to the old module object during the reload event!
        cache[id].__accepted = hook()
      }

    }
    return cache[id].exports;
  }

  /**
   * Patches the existing modules with new sources and returns a list of changes
   * (module id and old mapping. ATTENTION: This function does not do any reloading yet.
   *
   * @param mappings
   *    New mappings
   * @returns {Array}
   *    List of changes
   */
  function patch(mappings) {
    var compile = scope.compile;
    var changes = [];

    keys(mappings).forEach(function (id) {
      var old = scope.mappings[id];
      var mapping = mappings[id];
      var meta = mapping[2];
      if (!old || old[2].hash !== meta.hash) {
        compile(mapping);
        scope.mappings[id] = mapping;
        changes.push([id, old]);
      }
    });
    return changes;
  }

  /**
   * Reloads modules based on the given changes. If reloading fails, this function
   * tries to restore old implementation.
   *
   * @param changes
   *    Changes array received from "patch" function
   */
  function reload(changes) {
    var changedModules = changes.map(function (c) {
      return c[0];
    });
    var newMods = changes.filter(function (c) {
      return !c[1];
    }).map(function (c) {
      return c[0];
    });

    scope.reload(function () {
      try {
        info("Applying changes...");
        debug("Changed modules", changedModules);
        debug("New modules", newMods);
        evaluate(entryId, {});
        info("Reload complete!");
      } catch (e) {
        error("Error occurred while reloading changes. Restoring old implementation...");
        console.error(e);
        console.error(e.stack);
        try {
          restore();
          evaluate(entryId, {});
          info("Restored!");
        } catch (re) {
          error("Restore failed. You may need to refresh your browser... :-/");
          console.error(re);
          console.error(re.stack);
        }
      }
    })


    function evaluate(id, changeCache) {
      if (id in changeCache) {
        debug("Circular dependency detected for module", id, "not traversing any further...");
        return changeCache[id];
      }
      if (isExternalModule(id)) {
        debug("Module", id, "is an external module. Do not reload");
        return false;
      }
      var module = getModule(id);
      debug("Evaluate module details", module);

      // initially mark change status to follow module's change status
      // TODO: how to propagate change status from children to this without causing infinite recursion?
      var meChanged = contains(changedModules, id);
      changeCache[id] = meChanged;
      if (id in scope.cache) {
        delete scope.cache[id];
      }

      var deps = module.deps.filter(isLocalModule);
      var depsChanged = deps.map(function (dep) {
        return evaluate(dep, changeCache);
      });

      // In the case of circular dependencies, the module evaluation stops because of the
      // changeCache check above. Also module cache should be clear. However, if some circular
      // dependency (or its descendant) gets reloaded, it (re)loads new version of this
      // module back to cache. That's why we need to ensure that we're not
      //    1) reloading module twice (so that we don't break cross-refs)
      //    2) reload any new version if there is no need for reloading
      //
      // Hence the complex "scope.cache" stuff...
      //
      var isReloaded = module.cached !== undefined && id in scope.cache;
      var depChanged = any(depsChanged);

      if (isReloaded || depChanged || meChanged) {
        debug("Module changed", id, isReloaded, depChanged, meChanged);
        if (!isReloaded) {
          var msg = contains(newMods, id) ? " > Add new module   ::" : " > Reload module    ::";
          console.log(msg, id);
          load(id);
        } else {
          console.log(" > Already reloaded ::", id);
        }
        changeCache[id] = !allExportsProxies(id) && !isAccepted(id);
        return changeCache[id];
      } else {
        // restore old version of the module
        if (module.cached !== undefined) {
          scope.cache[id] = module.cached;
        }
        return false;
      }
    }

    function allExportsProxies(id) {
      var e = scope.cache[id].exports;
      return isProxy(e) || (isPlainObj(e) && all(vals(e), isProxy));

      function isProxy(x) {
        return x && !!x.__$$LiveReactLoadable;
      }
    }

    function isAccepted(id) {
      var accepted = scope.cache[id].__accepted;
      scope.cache[id].__accepted = false;
      if (accepted === true) {
        console.log(" > Manually accepted")
      }
      return accepted === true;
    }

    function restore() {
      changes.forEach(function (c) {
        var id = c[0], mapping = c[1];
        if (mapping) {
          debug("Restore old mapping", id);
          scope.mappings[id] = mapping;
        } else {
          debug("Delete new mapping", id);
          delete scope.mappings[id];
        }
      })
    }
  }

  function getModule(id) {
    return {
      deps: vals(scope.mappings[id][1]),
      meta: scope.mappings[id][2],
      cached: scope.cache[id]
    };
  }

  function handleBundleChange(newMappings) {
    info("Bundle changed");
    var changes = patch(newMappings);
    if (changes.length > 0) {
      reload(changes);
    } else {
      info("Nothing to reload");
    }
  }

  function handleBundleError(data) {
    error("Bundling error occurred");
    error(data.error);
  }


  // prepare mappings before starting the app
  forEachValue(scope.mappings, compile);

  if (options.babel) {
    if (isReactTransformEnabled(scope.mappings)) {
        info("LiveReactLoad Babel transform detected. Ready to rock!");
    } else {
      warn(
        "Could not detect LiveReactLoad transform (livereactload/babel-transform). " +
        "Please see instructions how to setup the transform:\n\n" +
        "https://github.com/milankinen/livereactload#installation"
      );
    }
  }

  scope.compile = compile;
  scope.load = load;

  debug("Options:", options);
  debug("Entries:", entryPoints, entryId);

  startClient();
  // standalone bundles may need the exports from entry module
  return load(entryId);


  // this function is stringified in browserify process and appended to the bundle
  // so these helper functions must be inlined into this function, otherwise
  // the function is not working

  function isReactTransformEnabled(mappings) {
    return any(vals(mappings), function (mapping) {
      var source = mapping[2].source;
      return source && source.indexOf("__$$LiveReactLoadable") !== -1;
    });
  }

  function isLocalModule(id) {
    return id.indexOf(options.nodeModulesRoot) === -1
  }

  function isExternalModule(id) {
    return !(id in scope.mappings);
  }

  function keys(obj) {
    return obj ? Object.keys(obj) : [];
  }

  function vals(obj) {
    return keys(obj).map(function (key) {
      return obj[key];
    });
  }

  function contains(col, val) {
    for (var i = 0; i < col.length; i++) {
      if (col[i] === val) return true;
    }
    return false;
  }

  function all(col, f) {
    if (!f) {
      f = function (x) {
        return x;
      };
    }
    for (var i = 0; i < col.length; i++) {
      if (!f(col[i])) return false;
    }
    return true;
  }

  function any(col, f) {
    if (!f) {
      f = function (x) {
        return x;
      };
    }
    for (var i = 0; i < col.length; i++) {
      if (f(col[i])) return true;
    }
    return false;
  }

  function forEachValue(obj, fn) {
    keys(obj).forEach(function (key) {
      if (obj.hasOwnProperty(key)) {
        fn(obj[key]);
      }
    });
  }

  function isPlainObj(x) {
    return typeof x == 'object' && x.constructor == Object;
  }

  function debug() {
    if (options.debug) {
      console.log.apply(console, ["LiveReactload [DEBUG] ::"].concat(Array.prototype.slice.call(arguments)));
    }
  }

  function info(msg) {
    console.info("LiveReactload ::", msg);
  }

  function warn(msg) {
    console.warn("LiveReactload ::", msg);
  }

  function error(msg) {
    console.error("LiveReactload ::", msg);
  }
})({
  "/Users/vadymrostok/code/pets/geometry-challenge/node_modules/regenerator-runtime/runtime.js": [
    "/**\n * Copyright (c) 2014-present, Facebook, Inc.\n *\n * This source code is licensed under the MIT license found in the\n * LICENSE file in the root directory of this source tree.\n */\n\nvar runtime = (function (exports) {\n  \"use strict\";\n\n  var Op = Object.prototype;\n  var hasOwn = Op.hasOwnProperty;\n  var undefined; // More compressible than void 0.\n  var $Symbol = typeof Symbol === \"function\" ? Symbol : {};\n  var iteratorSymbol = $Symbol.iterator || \"@@iterator\";\n  var asyncIteratorSymbol = $Symbol.asyncIterator || \"@@asyncIterator\";\n  var toStringTagSymbol = $Symbol.toStringTag || \"@@toStringTag\";\n\n  function define(obj, key, value) {\n    Object.defineProperty(obj, key, {\n      value: value,\n      enumerable: true,\n      configurable: true,\n      writable: true\n    });\n    return obj[key];\n  }\n  try {\n    // IE 8 has a broken Object.defineProperty that only works on DOM objects.\n    define({}, \"\");\n  } catch (err) {\n    define = function(obj, key, value) {\n      return obj[key] = value;\n    };\n  }\n\n  function wrap(innerFn, outerFn, self, tryLocsList) {\n    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.\n    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;\n    var generator = Object.create(protoGenerator.prototype);\n    var context = new Context(tryLocsList || []);\n\n    // The ._invoke method unifies the implementations of the .next,\n    // .throw, and .return methods.\n    generator._invoke = makeInvokeMethod(innerFn, self, context);\n\n    return generator;\n  }\n  exports.wrap = wrap;\n\n  // Try/catch helper to minimize deoptimizations. Returns a completion\n  // record like context.tryEntries[i].completion. This interface could\n  // have been (and was previously) designed to take a closure to be\n  // invoked without arguments, but in all the cases we care about we\n  // already have an existing method we want to call, so there's no need\n  // to create a new function object. We can even get away with assuming\n  // the method takes exactly one argument, since that happens to be true\n  // in every case, so we don't have to touch the arguments object. The\n  // only additional allocation required is the completion record, which\n  // has a stable shape and so hopefully should be cheap to allocate.\n  function tryCatch(fn, obj, arg) {\n    try {\n      return { type: \"normal\", arg: fn.call(obj, arg) };\n    } catch (err) {\n      return { type: \"throw\", arg: err };\n    }\n  }\n\n  var GenStateSuspendedStart = \"suspendedStart\";\n  var GenStateSuspendedYield = \"suspendedYield\";\n  var GenStateExecuting = \"executing\";\n  var GenStateCompleted = \"completed\";\n\n  // Returning this object from the innerFn has the same effect as\n  // breaking out of the dispatch switch statement.\n  var ContinueSentinel = {};\n\n  // Dummy constructor functions that we use as the .constructor and\n  // .constructor.prototype properties for functions that return Generator\n  // objects. For full spec compliance, you may wish to configure your\n  // minifier not to mangle the names of these two functions.\n  function Generator() {}\n  function GeneratorFunction() {}\n  function GeneratorFunctionPrototype() {}\n\n  // This is a polyfill for %IteratorPrototype% for environments that\n  // don't natively support it.\n  var IteratorPrototype = {};\n  IteratorPrototype[iteratorSymbol] = function () {\n    return this;\n  };\n\n  var getProto = Object.getPrototypeOf;\n  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));\n  if (NativeIteratorPrototype &&\n      NativeIteratorPrototype !== Op &&\n      hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {\n    // This environment has a native %IteratorPrototype%; use it instead\n    // of the polyfill.\n    IteratorPrototype = NativeIteratorPrototype;\n  }\n\n  var Gp = GeneratorFunctionPrototype.prototype =\n    Generator.prototype = Object.create(IteratorPrototype);\n  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;\n  GeneratorFunctionPrototype.constructor = GeneratorFunction;\n  GeneratorFunction.displayName = define(\n    GeneratorFunctionPrototype,\n    toStringTagSymbol,\n    \"GeneratorFunction\"\n  );\n\n  // Helper for defining the .next, .throw, and .return methods of the\n  // Iterator interface in terms of a single ._invoke method.\n  function defineIteratorMethods(prototype) {\n    [\"next\", \"throw\", \"return\"].forEach(function(method) {\n      define(prototype, method, function(arg) {\n        return this._invoke(method, arg);\n      });\n    });\n  }\n\n  exports.isGeneratorFunction = function(genFun) {\n    var ctor = typeof genFun === \"function\" && genFun.constructor;\n    return ctor\n      ? ctor === GeneratorFunction ||\n        // For the native GeneratorFunction constructor, the best we can\n        // do is to check its .name property.\n        (ctor.displayName || ctor.name) === \"GeneratorFunction\"\n      : false;\n  };\n\n  exports.mark = function(genFun) {\n    if (Object.setPrototypeOf) {\n      Object.setPrototypeOf(genFun, GeneratorFunctionPrototype);\n    } else {\n      genFun.__proto__ = GeneratorFunctionPrototype;\n      define(genFun, toStringTagSymbol, \"GeneratorFunction\");\n    }\n    genFun.prototype = Object.create(Gp);\n    return genFun;\n  };\n\n  // Within the body of any async function, `await x` is transformed to\n  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test\n  // `hasOwn.call(value, \"__await\")` to determine if the yielded value is\n  // meant to be awaited.\n  exports.awrap = function(arg) {\n    return { __await: arg };\n  };\n\n  function AsyncIterator(generator, PromiseImpl) {\n    function invoke(method, arg, resolve, reject) {\n      var record = tryCatch(generator[method], generator, arg);\n      if (record.type === \"throw\") {\n        reject(record.arg);\n      } else {\n        var result = record.arg;\n        var value = result.value;\n        if (value &&\n            typeof value === \"object\" &&\n            hasOwn.call(value, \"__await\")) {\n          return PromiseImpl.resolve(value.__await).then(function(value) {\n            invoke(\"next\", value, resolve, reject);\n          }, function(err) {\n            invoke(\"throw\", err, resolve, reject);\n          });\n        }\n\n        return PromiseImpl.resolve(value).then(function(unwrapped) {\n          // When a yielded Promise is resolved, its final value becomes\n          // the .value of the Promise<{value,done}> result for the\n          // current iteration.\n          result.value = unwrapped;\n          resolve(result);\n        }, function(error) {\n          // If a rejected Promise was yielded, throw the rejection back\n          // into the async generator function so it can be handled there.\n          return invoke(\"throw\", error, resolve, reject);\n        });\n      }\n    }\n\n    var previousPromise;\n\n    function enqueue(method, arg) {\n      function callInvokeWithMethodAndArg() {\n        return new PromiseImpl(function(resolve, reject) {\n          invoke(method, arg, resolve, reject);\n        });\n      }\n\n      return previousPromise =\n        // If enqueue has been called before, then we want to wait until\n        // all previous Promises have been resolved before calling invoke,\n        // so that results are always delivered in the correct order. If\n        // enqueue has not been called before, then it is important to\n        // call invoke immediately, without waiting on a callback to fire,\n        // so that the async generator function has the opportunity to do\n        // any necessary setup in a predictable way. This predictability\n        // is why the Promise constructor synchronously invokes its\n        // executor callback, and why async functions synchronously\n        // execute code before the first await. Since we implement simple\n        // async functions in terms of async generators, it is especially\n        // important to get this right, even though it requires care.\n        previousPromise ? previousPromise.then(\n          callInvokeWithMethodAndArg,\n          // Avoid propagating failures to Promises returned by later\n          // invocations of the iterator.\n          callInvokeWithMethodAndArg\n        ) : callInvokeWithMethodAndArg();\n    }\n\n    // Define the unified helper method that is used to implement .next,\n    // .throw, and .return (see defineIteratorMethods).\n    this._invoke = enqueue;\n  }\n\n  defineIteratorMethods(AsyncIterator.prototype);\n  AsyncIterator.prototype[asyncIteratorSymbol] = function () {\n    return this;\n  };\n  exports.AsyncIterator = AsyncIterator;\n\n  // Note that simple async functions are implemented on top of\n  // AsyncIterator objects; they just return a Promise for the value of\n  // the final result produced by the iterator.\n  exports.async = function(innerFn, outerFn, self, tryLocsList, PromiseImpl) {\n    if (PromiseImpl === void 0) PromiseImpl = Promise;\n\n    var iter = new AsyncIterator(\n      wrap(innerFn, outerFn, self, tryLocsList),\n      PromiseImpl\n    );\n\n    return exports.isGeneratorFunction(outerFn)\n      ? iter // If outerFn is a generator, return the full iterator.\n      : iter.next().then(function(result) {\n          return result.done ? result.value : iter.next();\n        });\n  };\n\n  function makeInvokeMethod(innerFn, self, context) {\n    var state = GenStateSuspendedStart;\n\n    return function invoke(method, arg) {\n      if (state === GenStateExecuting) {\n        throw new Error(\"Generator is already running\");\n      }\n\n      if (state === GenStateCompleted) {\n        if (method === \"throw\") {\n          throw arg;\n        }\n\n        // Be forgiving, per 25.3.3.3.3 of the spec:\n        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume\n        return doneResult();\n      }\n\n      context.method = method;\n      context.arg = arg;\n\n      while (true) {\n        var delegate = context.delegate;\n        if (delegate) {\n          var delegateResult = maybeInvokeDelegate(delegate, context);\n          if (delegateResult) {\n            if (delegateResult === ContinueSentinel) continue;\n            return delegateResult;\n          }\n        }\n\n        if (context.method === \"next\") {\n          // Setting context._sent for legacy support of Babel's\n          // function.sent implementation.\n          context.sent = context._sent = context.arg;\n\n        } else if (context.method === \"throw\") {\n          if (state === GenStateSuspendedStart) {\n            state = GenStateCompleted;\n            throw context.arg;\n          }\n\n          context.dispatchException(context.arg);\n\n        } else if (context.method === \"return\") {\n          context.abrupt(\"return\", context.arg);\n        }\n\n        state = GenStateExecuting;\n\n        var record = tryCatch(innerFn, self, context);\n        if (record.type === \"normal\") {\n          // If an exception is thrown from innerFn, we leave state ===\n          // GenStateExecuting and loop back for another invocation.\n          state = context.done\n            ? GenStateCompleted\n            : GenStateSuspendedYield;\n\n          if (record.arg === ContinueSentinel) {\n            continue;\n          }\n\n          return {\n            value: record.arg,\n            done: context.done\n          };\n\n        } else if (record.type === \"throw\") {\n          state = GenStateCompleted;\n          // Dispatch the exception by looping back around to the\n          // context.dispatchException(context.arg) call above.\n          context.method = \"throw\";\n          context.arg = record.arg;\n        }\n      }\n    };\n  }\n\n  // Call delegate.iterator[context.method](context.arg) and handle the\n  // result, either by returning a { value, done } result from the\n  // delegate iterator, or by modifying context.method and context.arg,\n  // setting context.delegate to null, and returning the ContinueSentinel.\n  function maybeInvokeDelegate(delegate, context) {\n    var method = delegate.iterator[context.method];\n    if (method === undefined) {\n      // A .throw or .return when the delegate iterator has no .throw\n      // method always terminates the yield* loop.\n      context.delegate = null;\n\n      if (context.method === \"throw\") {\n        // Note: [\"return\"] must be used for ES3 parsing compatibility.\n        if (delegate.iterator[\"return\"]) {\n          // If the delegate iterator has a return method, give it a\n          // chance to clean up.\n          context.method = \"return\";\n          context.arg = undefined;\n          maybeInvokeDelegate(delegate, context);\n\n          if (context.method === \"throw\") {\n            // If maybeInvokeDelegate(context) changed context.method from\n            // \"return\" to \"throw\", let that override the TypeError below.\n            return ContinueSentinel;\n          }\n        }\n\n        context.method = \"throw\";\n        context.arg = new TypeError(\n          \"The iterator does not provide a 'throw' method\");\n      }\n\n      return ContinueSentinel;\n    }\n\n    var record = tryCatch(method, delegate.iterator, context.arg);\n\n    if (record.type === \"throw\") {\n      context.method = \"throw\";\n      context.arg = record.arg;\n      context.delegate = null;\n      return ContinueSentinel;\n    }\n\n    var info = record.arg;\n\n    if (! info) {\n      context.method = \"throw\";\n      context.arg = new TypeError(\"iterator result is not an object\");\n      context.delegate = null;\n      return ContinueSentinel;\n    }\n\n    if (info.done) {\n      // Assign the result of the finished delegate to the temporary\n      // variable specified by delegate.resultName (see delegateYield).\n      context[delegate.resultName] = info.value;\n\n      // Resume execution at the desired location (see delegateYield).\n      context.next = delegate.nextLoc;\n\n      // If context.method was \"throw\" but the delegate handled the\n      // exception, let the outer generator proceed normally. If\n      // context.method was \"next\", forget context.arg since it has been\n      // \"consumed\" by the delegate iterator. If context.method was\n      // \"return\", allow the original .return call to continue in the\n      // outer generator.\n      if (context.method !== \"return\") {\n        context.method = \"next\";\n        context.arg = undefined;\n      }\n\n    } else {\n      // Re-yield the result returned by the delegate method.\n      return info;\n    }\n\n    // The delegate iterator is finished, so forget it and continue with\n    // the outer generator.\n    context.delegate = null;\n    return ContinueSentinel;\n  }\n\n  // Define Generator.prototype.{next,throw,return} in terms of the\n  // unified ._invoke helper method.\n  defineIteratorMethods(Gp);\n\n  define(Gp, toStringTagSymbol, \"Generator\");\n\n  // A Generator should always return itself as the iterator object when the\n  // @@iterator function is called on it. Some browsers' implementations of the\n  // iterator prototype chain incorrectly implement this, causing the Generator\n  // object to not be returned from this call. This ensures that doesn't happen.\n  // See https://github.com/facebook/regenerator/issues/274 for more details.\n  Gp[iteratorSymbol] = function() {\n    return this;\n  };\n\n  Gp.toString = function() {\n    return \"[object Generator]\";\n  };\n\n  function pushTryEntry(locs) {\n    var entry = { tryLoc: locs[0] };\n\n    if (1 in locs) {\n      entry.catchLoc = locs[1];\n    }\n\n    if (2 in locs) {\n      entry.finallyLoc = locs[2];\n      entry.afterLoc = locs[3];\n    }\n\n    this.tryEntries.push(entry);\n  }\n\n  function resetTryEntry(entry) {\n    var record = entry.completion || {};\n    record.type = \"normal\";\n    delete record.arg;\n    entry.completion = record;\n  }\n\n  function Context(tryLocsList) {\n    // The root entry object (effectively a try statement without a catch\n    // or a finally block) gives us a place to store values thrown from\n    // locations where there is no enclosing try statement.\n    this.tryEntries = [{ tryLoc: \"root\" }];\n    tryLocsList.forEach(pushTryEntry, this);\n    this.reset(true);\n  }\n\n  exports.keys = function(object) {\n    var keys = [];\n    for (var key in object) {\n      keys.push(key);\n    }\n    keys.reverse();\n\n    // Rather than returning an object with a next method, we keep\n    // things simple and return the next function itself.\n    return function next() {\n      while (keys.length) {\n        var key = keys.pop();\n        if (key in object) {\n          next.value = key;\n          next.done = false;\n          return next;\n        }\n      }\n\n      // To avoid creating an additional object, we just hang the .value\n      // and .done properties off the next function object itself. This\n      // also ensures that the minifier will not anonymize the function.\n      next.done = true;\n      return next;\n    };\n  };\n\n  function values(iterable) {\n    if (iterable) {\n      var iteratorMethod = iterable[iteratorSymbol];\n      if (iteratorMethod) {\n        return iteratorMethod.call(iterable);\n      }\n\n      if (typeof iterable.next === \"function\") {\n        return iterable;\n      }\n\n      if (!isNaN(iterable.length)) {\n        var i = -1, next = function next() {\n          while (++i < iterable.length) {\n            if (hasOwn.call(iterable, i)) {\n              next.value = iterable[i];\n              next.done = false;\n              return next;\n            }\n          }\n\n          next.value = undefined;\n          next.done = true;\n\n          return next;\n        };\n\n        return next.next = next;\n      }\n    }\n\n    // Return an iterator with no values.\n    return { next: doneResult };\n  }\n  exports.values = values;\n\n  function doneResult() {\n    return { value: undefined, done: true };\n  }\n\n  Context.prototype = {\n    constructor: Context,\n\n    reset: function(skipTempReset) {\n      this.prev = 0;\n      this.next = 0;\n      // Resetting context._sent for legacy support of Babel's\n      // function.sent implementation.\n      this.sent = this._sent = undefined;\n      this.done = false;\n      this.delegate = null;\n\n      this.method = \"next\";\n      this.arg = undefined;\n\n      this.tryEntries.forEach(resetTryEntry);\n\n      if (!skipTempReset) {\n        for (var name in this) {\n          // Not sure about the optimal order of these conditions:\n          if (name.charAt(0) === \"t\" &&\n              hasOwn.call(this, name) &&\n              !isNaN(+name.slice(1))) {\n            this[name] = undefined;\n          }\n        }\n      }\n    },\n\n    stop: function() {\n      this.done = true;\n\n      var rootEntry = this.tryEntries[0];\n      var rootRecord = rootEntry.completion;\n      if (rootRecord.type === \"throw\") {\n        throw rootRecord.arg;\n      }\n\n      return this.rval;\n    },\n\n    dispatchException: function(exception) {\n      if (this.done) {\n        throw exception;\n      }\n\n      var context = this;\n      function handle(loc, caught) {\n        record.type = \"throw\";\n        record.arg = exception;\n        context.next = loc;\n\n        if (caught) {\n          // If the dispatched exception was caught by a catch block,\n          // then let that catch block handle the exception normally.\n          context.method = \"next\";\n          context.arg = undefined;\n        }\n\n        return !! caught;\n      }\n\n      for (var i = this.tryEntries.length - 1; i >= 0; --i) {\n        var entry = this.tryEntries[i];\n        var record = entry.completion;\n\n        if (entry.tryLoc === \"root\") {\n          // Exception thrown outside of any try block that could handle\n          // it, so set the completion value of the entire function to\n          // throw the exception.\n          return handle(\"end\");\n        }\n\n        if (entry.tryLoc <= this.prev) {\n          var hasCatch = hasOwn.call(entry, \"catchLoc\");\n          var hasFinally = hasOwn.call(entry, \"finallyLoc\");\n\n          if (hasCatch && hasFinally) {\n            if (this.prev < entry.catchLoc) {\n              return handle(entry.catchLoc, true);\n            } else if (this.prev < entry.finallyLoc) {\n              return handle(entry.finallyLoc);\n            }\n\n          } else if (hasCatch) {\n            if (this.prev < entry.catchLoc) {\n              return handle(entry.catchLoc, true);\n            }\n\n          } else if (hasFinally) {\n            if (this.prev < entry.finallyLoc) {\n              return handle(entry.finallyLoc);\n            }\n\n          } else {\n            throw new Error(\"try statement without catch or finally\");\n          }\n        }\n      }\n    },\n\n    abrupt: function(type, arg) {\n      for (var i = this.tryEntries.length - 1; i >= 0; --i) {\n        var entry = this.tryEntries[i];\n        if (entry.tryLoc <= this.prev &&\n            hasOwn.call(entry, \"finallyLoc\") &&\n            this.prev < entry.finallyLoc) {\n          var finallyEntry = entry;\n          break;\n        }\n      }\n\n      if (finallyEntry &&\n          (type === \"break\" ||\n           type === \"continue\") &&\n          finallyEntry.tryLoc <= arg &&\n          arg <= finallyEntry.finallyLoc) {\n        // Ignore the finally entry if control is not jumping to a\n        // location outside the try/catch block.\n        finallyEntry = null;\n      }\n\n      var record = finallyEntry ? finallyEntry.completion : {};\n      record.type = type;\n      record.arg = arg;\n\n      if (finallyEntry) {\n        this.method = \"next\";\n        this.next = finallyEntry.finallyLoc;\n        return ContinueSentinel;\n      }\n\n      return this.complete(record);\n    },\n\n    complete: function(record, afterLoc) {\n      if (record.type === \"throw\") {\n        throw record.arg;\n      }\n\n      if (record.type === \"break\" ||\n          record.type === \"continue\") {\n        this.next = record.arg;\n      } else if (record.type === \"return\") {\n        this.rval = this.arg = record.arg;\n        this.method = \"return\";\n        this.next = \"end\";\n      } else if (record.type === \"normal\" && afterLoc) {\n        this.next = afterLoc;\n      }\n\n      return ContinueSentinel;\n    },\n\n    finish: function(finallyLoc) {\n      for (var i = this.tryEntries.length - 1; i >= 0; --i) {\n        var entry = this.tryEntries[i];\n        if (entry.finallyLoc === finallyLoc) {\n          this.complete(entry.completion, entry.afterLoc);\n          resetTryEntry(entry);\n          return ContinueSentinel;\n        }\n      }\n    },\n\n    \"catch\": function(tryLoc) {\n      for (var i = this.tryEntries.length - 1; i >= 0; --i) {\n        var entry = this.tryEntries[i];\n        if (entry.tryLoc === tryLoc) {\n          var record = entry.completion;\n          if (record.type === \"throw\") {\n            var thrown = record.arg;\n            resetTryEntry(entry);\n          }\n          return thrown;\n        }\n      }\n\n      // The context.catch method must only be called with a location\n      // argument that corresponds to a known catch block.\n      throw new Error(\"illegal catch attempt\");\n    },\n\n    delegateYield: function(iterable, resultName, nextLoc) {\n      this.delegate = {\n        iterator: values(iterable),\n        resultName: resultName,\n        nextLoc: nextLoc\n      };\n\n      if (this.method === \"next\") {\n        // Deliberately forget the last sent value so that we don't\n        // accidentally pass it on to the delegate.\n        this.arg = undefined;\n      }\n\n      return ContinueSentinel;\n    }\n  };\n\n  // Regardless of whether this script is executing as a CommonJS module\n  // or not, return the runtime object so that we can declare the variable\n  // regeneratorRuntime in the outer scope, which allows this module to be\n  // injected easily by `bin/regenerator --include-runtime script.js`.\n  return exports;\n\n}(\n  // If this script is executing as a CommonJS module, use module.exports\n  // as the regeneratorRuntime namespace. Otherwise create a new empty\n  // object. Either way, the resulting object will be used to initialize\n  // the regeneratorRuntime variable at the top of this file.\n  typeof module === \"object\" ? module.exports : {}\n));\n\ntry {\n  regeneratorRuntime = runtime;\n} catch (accidentalStrictMode) {\n  // This module should not be running in strict mode, so the above\n  // assignment should always work unless something is misconfigured. Just\n  // in case runtime.js accidentally runs in strict mode, we can escape\n  // strict mode using a global Function call. This could conceivably fail\n  // if a Content Security Policy forbids using Function, but in that case\n  // the proper solution is to fix the accidental strict mode problem. If\n  // you've misconfigured your bundler to force strict mode and applied a\n  // CSP to forbid Function, and you're not willing to fix either of those\n  // problems, please detail your unique predicament in a GitHub issue.\n  Function(\"r\", \"regeneratorRuntime = r\")(runtime);\n}\n",
    {},
    {
      "id": "/Users/vadymrostok/code/pets/geometry-challenge/node_modules/regenerator-runtime/runtime.js",
      "hash": "7yA0Tg",
      "browserifyId": 1,
      "sourcemap": ""
    }
  ],
  "/Users/vadymrostok/code/pets/geometry-challenge/node_modules/three/build/three.js": [
    {},
    {
      "id": "/Users/vadymrostok/code/pets/geometry-challenge/node_modules/three/build/three.js",
      "hash": "dz2H0Q",
      "browserifyId": 2,
      "sourcemap": ""
    }
  ],
  "/Users/vadymrostok/code/pets/geometry-challenge/src/ClosestPointDemo.js": [
    "\"use strict\";\n\nObject.defineProperty(exports, \"__esModule\", {\n  value: true\n});\nexports[\"default\"] = void 0;\n\nrequire(\"regenerator-runtime/runtime.js\");\n\nvar _stats = _interopRequireDefault(require(\"./stats.js\"));\n\nvar _three = require(\"three\");\n\nvar _closestPointInPolygon = _interopRequireDefault(require(\"./closestPointInPolygon\"));\n\nfunction _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { \"default\": obj }; }\n\n/**\nTODO:\n*/\nvar raycaster = new _three.Raycaster();\nvar normalizedMouse = new _three.Vector2();\nvar mouse = new _three.Vector2();\n\nvar _default = function _default() {\n  var container = document.getElementById('container');\n  var renderer = new _three.WebGLRenderer();\n  renderer.setPixelRatio(window.devicePixelRatio);\n  renderer.setSize(window.innerWidth, window.innerHeight);\n  container.appendChild(renderer.domElement);\n  var stats = new _stats[\"default\"]();\n  stats.domElement.style.position = 'absolute';\n  stats.domElement.style.top = '0px';\n  document.body.appendChild(stats.domElement);\n  var scene = new _three.Scene();\n  scene.background = new _three.Color(0xbfd1e5); // const camera = new OrthographicCamera(width/-2, width/2, height/2, height/-2, 1, 1000);\n\n  var _ref = [window.innerWidth, window.innerHeight],\n      windowWidth = _ref[0],\n      windowHeight = _ref[1];\n  var aspectRatio = windowWidth / windowHeight;\n  var camera = new _three.OrthographicCamera(-50 * aspectRatio, 50 * aspectRatio, 50, -50, 1, 1000);\n  camera.position.x = 0;\n  camera.position.y = 0;\n  camera.position.z = 5;\n  camera.lookAt(0, 0, 0);\n  window.addEventListener('resize', function () {\n    var _ref2 = [window.innerWidth, window.innerHeight];\n    windowWidth = _ref2[0];\n    windowHeight = _ref2[1];\n    aspectRatio = windowWidth / windowHeight;\n    camera.left = -50 * aspectRatio;\n    camera.right = 50 * aspectRatio;\n    renderer.setSize(window.innerWidth, window.innerHeight);\n    camera.updateProjectionMatrix();\n  }, false);\n  var polygonPointerMultiplier = 0.1;\n\n  function createPolygonPointer(color, points) {\n    var pointer = new _three.Shape();\n    pointer.moveTo(points[0].x * polygonPointerMultiplier, points[0].y * polygonPointerMultiplier);\n    points.slice(1).forEach(function (_ref3) {\n      var x = _ref3.x,\n          y = _ref3.y;\n      pointer.lineTo(x * polygonPointerMultiplier, y * polygonPointerMultiplier);\n    });\n    var polygonPointer = new _three.Mesh(new _three.ShapeGeometry(pointer), new _three.MeshBasicMaterial({\n      color: color\n    }));\n    polygonPointer.position.set(0, 0, 0.5);\n    scene.add(polygonPointer);\n    return polygonPointer;\n  }\n\n  var shapes = [function () {\n    var points = [{\n      x: -10.0,\n      y: -10.0\n    }, {\n      x: 10.0,\n      y: -10.0\n    }, {\n      x: 0.0,\n      y: 0.0\n    }, {\n      x: 10.0,\n      y: 10.0\n    }, {\n      x: -10.0,\n      y: 10.0\n    }, {\n      x: -10.0,\n      y: -10.0\n    }];\n    return {\n      // flag\n      position: {\n        x: -20,\n        y: 20\n      },\n      points: points,\n      polygonPointer: createPolygonPointer(0xffff00, points),\n      mesh: null\n    };\n  }(), function () {\n    var points = [{\n      x: -10.0,\n      y: -10.0\n    }, {\n      x: 10.0,\n      y: -10.0\n    }, {\n      x: 0.0,\n      y: 10.0\n    }, {\n      x: -10.0,\n      y: -10.0\n    }];\n    return {\n      // triangle\n      position: {\n        x: 20,\n        y: 20\n      },\n      points: points,\n      polygonPointer: createPolygonPointer(0xff00ff, points),\n      mesh: null\n    };\n  }()];\n  shapes.forEach(function (shape) {\n    var points = shape.points,\n        position = shape.position;\n    var geometry = new _three.BufferGeometry();\n    var vertices = new Float32Array(points.reduce(function (a, _ref4) {\n      var x = _ref4.x,\n          y = _ref4.y;\n      a = a.concat([x, y, 0]);\n      return a;\n    }, []));\n    geometry.addAttribute('position', new _three.BufferAttribute(vertices, 3));\n    var lineMesh = new _three.Line(geometry, new _three.LineBasicMaterial({\n      color: 0xff3377,\n      linewidth: 5,\n      linecap: 'round',\n      linejoin: 'round'\n    })); // TODO: add comment\n\n    var raycastTargetMesh = new _three.Mesh(geometry, new _three.MeshBasicMaterial({\n      color: 0xaabbcc\n    }));\n    lineMesh.position.set(position.x, position.y, 0);\n    raycastTargetMesh.position.set(position.x, position.y, 0);\n    shape.mesh = raycastTargetMesh;\n    scene.add(lineMesh);\n    scene.add(raycastTargetMesh);\n  }); // const closestPoint = new Mesh(new SphereGeometry(2, 8, 8), new MeshBasicMaterial({color: 0xff0000}));\n  // closestPoint.position.x = 0;\n  // closestPoint.position.y = 0;\n  // closestPoint.position.z = 0;\n  // scene.add(closestPoint);\n\n  var light = new _three.AmbientLight(0x404040); // soft white light\n\n  scene.add(light); // let useIntersects = false;\n  // setTimeout(() => { useIntersects = true; }, 3000);\n\n  function loop() {\n    requestAnimationFrame(loop);\n    raycaster.setFromCamera(normalizedMouse, camera);\n    renderer.render(scene, camera);\n    stats.update();\n    shapes.forEach(function (_ref5) {\n      var points = _ref5.points,\n          position = _ref5.position,\n          polygonPointer = _ref5.polygonPointer,\n          mesh = _ref5.mesh;\n      var intersects = raycaster.intersectObject(mesh);\n\n      if (intersects.length) {\n        var _intersects$0$point = intersects[0].point,\n            x = _intersects$0$point.x,\n            y = _intersects$0$point.y;\n        polygonPointer.position.set(x, y, 0.5);\n      } else {\n        var _closestPointInPolygo = (0, _closestPointInPolygon[\"default\"])(points.map(function (_ref6) {\n          var x = _ref6.x,\n              y = _ref6.y;\n          return {\n            x: x + position.x,\n            y: y + position.y\n          };\n        }), {\n          x: mouse.x,\n          y: mouse.y\n        }),\n            _x = _closestPointInPolygo.x,\n            _y = _closestPointInPolygo.y;\n\n        polygonPointer.position.set(_x, _y, 0.5);\n      }\n    });\n  }\n\n  document.addEventListener('mousemove', function (_ref7) {\n    var clientX = _ref7.clientX,\n        clientY = _ref7.clientY;\n    mouse.x = (clientX / windowWidth * 100 - 50) * aspectRatio;\n    mouse.y = -clientY / windowHeight * 100 + 50;\n    normalizedMouse.x = clientX / windowWidth * 2 - 1;\n    normalizedMouse.y = -(clientY / windowHeight) * 2 + 1;\n  });\n  loop();\n};\n\nexports[\"default\"] = _default;\n",
    {
      "./closestPointInPolygon": "/Users/vadymrostok/code/pets/geometry-challenge/src/closestPointInPolygon.js",
      "./stats.js": "/Users/vadymrostok/code/pets/geometry-challenge/src/stats.js",
      "regenerator-runtime/runtime.js": "/Users/vadymrostok/code/pets/geometry-challenge/node_modules/regenerator-runtime/runtime.js",
      "three": "/Users/vadymrostok/code/pets/geometry-challenge/node_modules/three/build/three.js"
    },
    {
      "id": "/Users/vadymrostok/code/pets/geometry-challenge/src/ClosestPointDemo.js",
      "hash": "t8yAKw",
      "browserifyId": 3,
      "sourcemap": "//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIkNsb3Nlc3RQb2ludERlbW8uanM/dmVyc2lvbj10OHlBS3ciXSwibmFtZXMiOlsicmF5Y2FzdGVyIiwiUmF5Y2FzdGVyIiwibm9ybWFsaXplZE1vdXNlIiwiVmVjdG9yMiIsIm1vdXNlIiwiY29udGFpbmVyIiwiZG9jdW1lbnQiLCJnZXRFbGVtZW50QnlJZCIsInJlbmRlcmVyIiwiV2ViR0xSZW5kZXJlciIsInNldFBpeGVsUmF0aW8iLCJ3aW5kb3ciLCJkZXZpY2VQaXhlbFJhdGlvIiwic2V0U2l6ZSIsImlubmVyV2lkdGgiLCJpbm5lckhlaWdodCIsImFwcGVuZENoaWxkIiwiZG9tRWxlbWVudCIsInN0YXRzIiwiU3RhdHMiLCJzdHlsZSIsInBvc2l0aW9uIiwidG9wIiwiYm9keSIsInNjZW5lIiwiU2NlbmUiLCJiYWNrZ3JvdW5kIiwiQ29sb3IiLCJ3aW5kb3dXaWR0aCIsIndpbmRvd0hlaWdodCIsImFzcGVjdFJhdGlvIiwiY2FtZXJhIiwiT3J0aG9ncmFwaGljQ2FtZXJhIiwieCIsInkiLCJ6IiwibG9va0F0IiwiYWRkRXZlbnRMaXN0ZW5lciIsImxlZnQiLCJyaWdodCIsInVwZGF0ZVByb2plY3Rpb25NYXRyaXgiLCJwb2x5Z29uUG9pbnRlck11bHRpcGxpZXIiLCJjcmVhdGVQb2x5Z29uUG9pbnRlciIsImNvbG9yIiwicG9pbnRzIiwicG9pbnRlciIsIlNoYXBlIiwibW92ZVRvIiwic2xpY2UiLCJmb3JFYWNoIiwibGluZVRvIiwicG9seWdvblBvaW50ZXIiLCJNZXNoIiwiU2hhcGVHZW9tZXRyeSIsIk1lc2hCYXNpY01hdGVyaWFsIiwic2V0IiwiYWRkIiwic2hhcGVzIiwibWVzaCIsInNoYXBlIiwiZ2VvbWV0cnkiLCJCdWZmZXJHZW9tZXRyeSIsInZlcnRpY2VzIiwiRmxvYXQzMkFycmF5IiwicmVkdWNlIiwiYSIsImNvbmNhdCIsImFkZEF0dHJpYnV0ZSIsIkJ1ZmZlckF0dHJpYnV0ZSIsImxpbmVNZXNoIiwiTGluZSIsIkxpbmVCYXNpY01hdGVyaWFsIiwibGluZXdpZHRoIiwibGluZWNhcCIsImxpbmVqb2luIiwicmF5Y2FzdFRhcmdldE1lc2giLCJsaWdodCIsIkFtYmllbnRMaWdodCIsImxvb3AiLCJyZXF1ZXN0QW5pbWF0aW9uRnJhbWUiLCJzZXRGcm9tQ2FtZXJhIiwicmVuZGVyIiwidXBkYXRlIiwiaW50ZXJzZWN0cyIsImludGVyc2VjdE9iamVjdCIsImxlbmd0aCIsInBvaW50IiwibWFwIiwiY2xpZW50WCIsImNsaWVudFkiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O0FBR0E7O0FBRUE7O0FBRUE7O0FBcUJBOzs7O0FBNUJBO0FBQ0E7QUFDQTtBQTRCQSxJQUFNQSxTQUFTLEdBQUcsSUFBSUMsZ0JBQUosRUFBbEI7QUFDQSxJQUFNQyxlQUFlLEdBQUcsSUFBSUMsY0FBSixFQUF4QjtBQUNBLElBQU1DLEtBQUssR0FBRyxJQUFJRCxjQUFKLEVBQWQ7O2VBRWUsb0JBQU07QUFDbkIsTUFBTUUsU0FBUyxHQUFHQyxRQUFRLENBQUNDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFFQSxNQUFNQyxRQUFRLEdBQUcsSUFBSUMsb0JBQUosRUFBakI7QUFDQUQsRUFBQUEsUUFBUSxDQUFDRSxhQUFULENBQXVCQyxNQUFNLENBQUNDLGdCQUE5QjtBQUNBSixFQUFBQSxRQUFRLENBQUNLLE9BQVQsQ0FBaUJGLE1BQU0sQ0FBQ0csVUFBeEIsRUFBb0NILE1BQU0sQ0FBQ0ksV0FBM0M7QUFFQVYsRUFBQUEsU0FBUyxDQUFDVyxXQUFWLENBQXNCUixRQUFRLENBQUNTLFVBQS9CO0FBRUEsTUFBTUMsS0FBSyxHQUFHLElBQUlDLGlCQUFKLEVBQWQ7QUFDQUQsRUFBQUEsS0FBSyxDQUFDRCxVQUFOLENBQWlCRyxLQUFqQixDQUF1QkMsUUFBdkIsR0FBa0MsVUFBbEM7QUFDQUgsRUFBQUEsS0FBSyxDQUFDRCxVQUFOLENBQWlCRyxLQUFqQixDQUF1QkUsR0FBdkIsR0FBNkIsS0FBN0I7QUFDQWhCLEVBQUFBLFFBQVEsQ0FBQ2lCLElBQVQsQ0FBY1AsV0FB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O0FBQXZCLFNBTmUsQ0FEWjtBQUFBLFlBQ0dELEVBREgseUJBQ0dBLENBREg7QUFBQSxZQUNNQyxFQUROLHlCQUNNQSxDQUROOztBQVNMaUIsUUFBQUEsY0FBYyxDQUFDOUIsUUFBZixDQUF3QmtDLEdBQXhCLENBQTRCdEIsRUFBNUIsRUFBK0JDLEVBQS9CLEVBQWtDLEdBQWxDO0FBQ0Q7QUFDRixLQWxCRDtBQW9CRDs7QUFFRDVCLEVBQUFBLFFBQVEsQ0FBQytCLGdCQUFULENBQTBCLFdBQTFCLEVBQXVDLGlCQUEwQjtBQUFBLFFBQXZCbUQsT0FBdUIsU0FBdkJBLE9BQXVCO0FBQUEsUUFBZEMsT0FBYyxTQUFkQSxPQUFjO0FBQy9EckYsSUFBQUEsS0FBSyxDQUFDNkIsQ0FBTixHQUFVLENBQUN1RCxPQUFPLEdBQUc1RCxXQUFWLEdBQXdCLEdBQXhCLEdBQThCLEVBQS9CLElBQXFDRSxXQUEvQztBQUNBMUIsSUFBQUEsS0FBSyxDQUFDOEIsQ0FBTixHQUFVLENBQUN1RCxPQUFELEdBQVc1RCxZQUFYLEdBQTBCLEdBQTFCLEdBQWdDLEVBQTFDO0FBQ0EzQixJQUFBQSxlQUFlLENBQUMrQixDQUFoQixHQUFzQnVELE9BQU8sR0FBRzVELFdBQVosR0FBNEIsQ0FBNUIsR0FBZ0MsQ0FBcEQ7QUFDQTFCLElBQUFBLGVBQWUsQ0FBQ2dDLENBQWhCLEdBQW9CLEVBQUl1RCxPQUFPLEdBQUc1RCxZQUFkLElBQStCLENBQS9CLEdBQW1DLENBQXZEO0FBQ0QsR0FMRDtBQU9BaUQsRUFBQUEsSUFBSTtBQUNMIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG5UT0RPOlxuKi8gXG5pbXBvcnQgJ3JlZ2VuZXJhdG9yLXJ1bnRpbWUvcnVudGltZS5qcyc7XG5cbmltcG9ydCBTdGF0cyBmcm9tICcuL3N0YXRzLmpzJztcblxuaW1wb3J0IHtcbiAgV2ViR0xSZW5kZXJlcixcbiAgT3J0aG9ncmFwaGljQ2FtZXJhLFxuICBTY2VuZSxcbiAgQ29sb3IsXG4gIFNoYXBlLFxuICBNZXNoLFxuICBTaGFwZUdlb21ldHJ5LFxuICBNZXNoQmFzaWNNYXRlcmlhbCxcbiAgTWVzaFBoeXNpY2FsTWF0ZXJpYWwsXG4gIEFtYmllbnRMaWdodCxcbiAgU3BoZXJlR2VvbWV0cnksXG4gIEJ1ZmZlckF0dHJpYnV0ZSxcbiAgQnVmZmVyR2VvbWV0cnksXG4gIExpbmUsXG4gIExpbmVCYXNpY01hdGVyaWFsLFxuICBWZWN0b3IzLFxuICBWZWN0b3IyLFxuICBSYXljYXN0ZXIsXG59IGZyb20gJ3RocmVlJztcblxuaW1wb3J0IGNsb3Nlc3RQb2ludEluUG9seWdvbiBmcm9tICcuL2Nsb3Nlc3RQb2ludEluUG9seWdvbic7XG5cbmNvbnN0IHJheWNhc3RlciA9IG5ldyBSYXljYXN0ZXIoKTtcbmNvbnN0IG5vcm1hbGl6ZWRNb3VzZSA9IG5ldyBWZWN0b3IyKCk7XG5jb25zdCBtb3VzZSA9IG5ldyBWZWN0b3IyKCk7XG5cbmV4cG9ydCBkZWZhdWx0ICgpID0+IHtcbiAgY29uc3QgY29udGFpbmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbnRhaW5lcicpO1xuXG4gIGNvbnN0IHJlbmRlcmVyID0gbmV3IFdlYkdMUmVuZGVyZXIoKTtcbiAgcmVuZGVyZXIuc2V0UGl4ZWxSYXRpbyh3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyk7XG4gIHJlbmRlcmVyLnNldFNpemUod2luZG93LmlubmVyV2lkdGgsIHdpbmRvdy5pbm5lckhlaWdodCk7XG5cbiAgY29udGFpbmVyLmFwcGVuZENoaWxkKHJlbmRlcmVyLmRvbUVsZW1lbnQpO1xuXG4gIGNvbnN0IHN0YXRzID0gbmV3IFN0YXRzKCk7XG4gIHN0YXRzLmRvbUVsZW1lbnQuc3R5bGUucG9zaXRpb24gPSAnYWJzb2x1dGUnO1xuICBzdGF0cy5kb21FbGVtZW50LnN0eWxlLnRvcCA9ICcwcHgnO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKCBzdGF0cy5kb21FbGVtZW50ICk7XG5cbiAgY29uc3Qgc2NlbmUgPSBuZXcgU2NlbmUoKTtcbiAgc2NlbmUuYmFja2dyb3VuZCA9IG5ldyBDb2xvciggMHhiZmQxZTUgKTtcblxuICAvLyBjb25zdCBjYW1lcmEgPSBuZXcgT3J0aG9ncmFwaGljQ2FtZXJhKHdpZHRoLy0yLCB3aWR0aC8yLCBoZWlnaHQvMiwgaGVpZ2h0Ly0yLCAxLCAxMDAwKTtcbiAgbGV0IFt3aW5kb3dXaWR0aCwgd2luZG93SGVpZ2h0XSA9IFt3aW5kb3cuaW5uZXJXaWR0aCwgd2luZG93LmlubmVySGVpZ2h0XTtcbiAgbGV0IGFzcGVjdFJhdGlvID0gd2luZG93V2lkdGgvd2luZG93SGVpZ2h0O1xuICBjb25zdCBjYW1lcmEgPSBuZXcgT3J0aG9ncmFwaGljQ2FtZXJhKFxuICAgIC01MCphc3BlY3RSYXRpbyxcbiAgICA1MCphc3BlY3RSYXRpbyxcbiAgICA1MCxcbiAgICAtNTAsXG4gICAgMSxcbiAgICAxMDAwLFxuICApO1xuICBjYW1lcmEucG9zaXRpb24ueCA9IDA7XG4gIGNhbWVyYS5wb3NpdGlvbi55ID0gMDtcbiAgY2FtZXJhLnBvc2l0aW9uLnogPSA1O1xuICBjYW1lcmEubG9va0F0KCAwLCAwLCAwICk7XG5cbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsICgpID0+IHtcbiAgICBbd2luZG93V2lkdGgsIHdpbmRvd0hlaWdodF0gPSBbd2luZG93LmlubmVyV2lkdGgsIHdpbmRvdy5pbm5lckhlaWdodF07XG4gICAgYXNwZWN0UmF0aW8gPSB3aW5kb3dXaWR0aC93aW5kb3dIZWlnaHQ7XG4gICAgY2FtZXJhLmxlZnQgPSAtNTAqYXNwZWN0UmF0aW87XG4gICAgY2FtZXJhLnJpZ2h0ID0gNTAqYXNwZWN0UmF0aW87XG4gICAgcmVuZGVyZXIuc2V0U2l6ZSh3aW5kb3cuaW5uZXJXaWR0aCwgd2luZG93LmlubmVySGVpZ2h0KTtcbiAgICBjYW1lcmEudXBkYXRlUHJvamVjdGlvbk1hdHJpeCgpO1xuICB9LCBmYWxzZSk7XG5cbiAgY29uc3QgcG9seWdvblBvaW50ZXJNdWx0aXBsaWVyID0gMC4xO1xuICBmdW5jdGlvbiBjcmVhdGVQb2x5Z29uUG9pbnRlcihjb2xvciwgcG9pbnRzKSB7XG4gICAgY29uc3QgcG9pbnRlciA9IG5ldyBTaGFwZSgpO1xuXG4gICAgcG9pbnRlci5tb3ZlVG8ocG9pbnRzWzBdLnggKiBwb2x5Z29uUG9pbnRlck11bHRpcGxpZXIsIHBvaW50c1swXS55ICogcG9seWdvblBvaW50ZXJNdWx0aXBsaWVyKTtcbiAgICBwb2ludHMuc2xpY2UoMSkuZm9yRWFjaCgoeyB4LCB5IH0pID0+IHtcbiAgICAgIHBvaW50ZXIubGluZVRvKHggKiBwb2x5Z29uUG9pbnRlck11bHRpcGxpZXIsIHkgKiBwb2x5Z29uUG9pbnRlck11bHRpcGxpZXIpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgcG9seWdvblBvaW50ZXIgPSBuZXcgTWVzaChuZXcgU2hhcGVHZW9tZXRyeShwb2ludGVyKSwgbmV3IE1lc2hCYXNpY01hdGVyaWFsKHsgY29sb3IgfSkpO1xuICAgIHBvbHlnb25Qb2ludGVyLnBvc2l0aW9uLnNldCgwLCAwLCAwLjUpO1xuXG4gICAgc2NlbmUuYWRkKHBvbHlnb25Qb2ludGVyKTtcblxuICAgIHJldHVybiBwb2x5Z29uUG9pbnRlcjtcbiAgfVxuXG4gIGNvbnN0IHNoYXBlcyA9IFtcbiAgICAoKCkgPT4ge1xuICAgICAgY29uc3QgcG9pbnRzID0gW1xuICAgICAgICB7IHg6IC0xMC4wLCB5OiAtMTAuMCB9LFxuICAgICAgICB7IHg6IDEwLjAsIHk6IC0xMC4wIH0sXG4gICAgICAgIHsgeDogMC4wLCAgeTogMC4wIH0sXG4gICAgICAgIHsgeDogMTAuMCwgeTogIDEwLjAgfSxcbiAgICAgICAgeyB4OiAtMTAuMCwgeTogIDEwLjAgfSxcbiAgICAgICAgeyB4OiAtMTAuMCwgeTogLTEwLjAgfSxcbiAgICAgIF07XG5cbiAgICAgIHJldHVybiB7IC8vIGZsYWdcbiAgICAgICAgcG9zaXRpb246IHsgeDogLTIwLCB5OiAyMCB9LFxuICAgICAgICBwb2ludHMsXG4gICAgICAgIHBvbHlnb25Qb2ludGVyOiBjcmVhdGVQb2x5Z29uUG9pbnRlcigweGZmZmYwMCwgcG9pbnRzKSxcbiAgICAgICAgbWVzaDogbnVsbCxcbiAgICAgIH07XG4gICAgfSkoKSxcbiAgICAoKCkgPT4ge1xuICAgICAgY29uc3QgcG9pbnRzID0gW1xuICAgICAgICB7IHg6IC0xMC4wLCB5OiAtMTAuMCB9LFxuICAgICAgICB7IHg6IDEwLjAsIHk6IC0xMC4wIH0sXG4gICAgICAgIHsgeDogMC4wLCAgeTogMTAuMCB9LFxuICAgICAgICB7IHg6IC0xMC4wLCB5OiAtMTAuMCB9LFxuICAgICAgXTtcbiAgICAgIHJldHVybiB7IC8vIHRyaWFuZ2xlXG4gICAgICAgIHBvc2l0aW9uOiB7IHg6IDIwLCB5OiAyMCB9LFxuICAgICAgICBwb2ludHMsXG4gICAgICAgIHBvbHlnb25Qb2ludGVyOiBjcmVhdGVQb2x5Z29uUG9pbnRlcigweGZmMDBmZiwgcG9pbnRzKSxcbiAgICAgICAgbWVzaDogbnVsbCxcbiAgICAgIH07XG4gICAgfSkoKVxuICBdO1xuXG4gIHNoYXBlcy5mb3JFYWNoKChzaGFwZSkgPT4ge1xuICAgIGNvbnN0IHsgcG9pbnRzLCBwb3NpdGlvbiB9ID0gc2hhcGU7XG4gICAgY29uc3QgZ2VvbWV0cnkgPSBuZXcgQnVmZmVyR2VvbWV0cnkoKTtcbiAgICBjb25zdCB2ZXJ0aWNlcyA9IG5ldyBGbG9hdDMyQXJyYXkocG9pbnRzLnJlZHVjZSgoYSwgeyB4LCB5IH0pID0+IHtcbiAgICAgIGEgPSBhLmNvbmNhdChbeCwgeSwgMF0pO1xuICAgICAgcmV0dXJuIGE7XG4gICAgfSwgW10pKTtcblxuICAgIGdlb21ldHJ5LmFkZEF0dHJpYnV0ZSgncG9zaXRpb24nLCBuZXcgQnVmZmVyQXR0cmlidXRlKHZlcnRpY2VzLCAzKSk7XG5cbiAgICBjb25zdCBsaW5lTWVzaCA9IG5ldyBMaW5lKGdlb21ldHJ5LCBuZXcgTGluZUJhc2ljTWF0ZXJpYWwoe1xuICAgICAgY29sb3I6IDB4ZmYzMzc3LFxuICAgICAgbGluZXdpZHRoOiA1LFxuICAgICAgbGluZWNhcDogJ3JvdW5kJyxcbiAgICAgIGxpbmVqb2luOiAgJ3JvdW5kJ1xuICAgIH0pKTtcblxuICAgIC8vIFRPRE86IGFkZCBjb21tZW50XG4gICAgY29uc3QgcmF5Y2FzdFRhcmdldE1lc2ggPSBuZXcgTWVzaChnZW9tZXRyeSwgbmV3IE1lc2hCYXNpY01hdGVyaWFsKHtcbiAgICAgIGNvbG9yOiAweGFhYmJjYyxcbiAgICB9KSk7XG5cbiAgICBsaW5lTWVzaC5wb3NpdGlvbi5zZXQocG9zaXRpb24ueCwgcG9zaXRpb24ueSwgMCk7XG4gICAgcmF5Y2FzdFRhcmdldE1lc2gucG9zaXRpb24uc2V0KHBvc2l0aW9uLngsIHBvc2l0aW9uLnksIDApO1xuXG4gICAgc2hhcGUubWVzaCA9IHJheWNhc3RUYXJnZXRNZXNoO1xuXG4gICAgc2NlbmUuYWRkKGxpbmVNZXNoKTtcbiAgICBzY2VuZS5hZGQocmF5Y2FzdFRhcmdldE1lc2gpO1xuICB9KTtcblxuICAvLyBjb25zdCBjbG9zZXN0UG9pbnQgPSBuZXcgTWVzaChuZXcgU3BoZXJlR2VvbWV0cnkoMiwgOCwgOCksIG5ldyBNZXNoQmFzaWNNYXRlcmlhbCh7Y29sb3I6IDB4ZmYwMDAwfSkpO1xuICAvLyBjbG9zZXN0UG9pbnQucG9zaXRpb24ueCA9IDA7XG4gIC8vIGNsb3Nlc3RQb2ludC5wb3NpdGlvbi55ID0gMDtcbiAgLy8gY2xvc2VzdFBvaW50LnBvc2l0aW9uLnogPSAwO1xuXG4gIC8vIHNjZW5lLmFkZChjbG9zZXN0UG9pbnQpO1xuXG4gIGNvbnN0IGxpZ2h0ID0gbmV3IEFtYmllbnRMaWdodCggMHg0MDQwNDAgKTsgLy8gc29mdCB3aGl0ZSBsaWdodFxuICBzY2VuZS5hZGQoIGxpZ2h0ICk7XG5cbiAgLy8gbGV0IHVzZUludGVyc2VjdHMgPSBmYWxzZTtcbiAgLy8gc2V0VGltZW91dCgoKSA9PiB7IHVzZUludGVyc2VjdHMgPSB0cnVlOyB9LCAzMDAwKTtcblxuICBmdW5jdGlvbiBsb29wKCkge1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSggbG9vcCApO1xuXG4gICAgcmF5Y2FzdGVyLnNldEZyb21DYW1lcmEoIG5vcm1hbGl6ZWRNb3VzZSwgY2FtZXJhICk7XG5cbiAgICByZW5kZXJlci5yZW5kZXIoc2NlbmUsIGNhbWVyYSk7XG5cbiAgICBzdGF0cy51cGRhdGUoKTtcblxuICAgIHNoYXBlcy5mb3JFYWNoKCh7IHBvaW50cywgcG9zaXRpb24sIHBvbHlnb25Qb2ludGVyLCBtZXNoIH0pID0+IHtcbiAgICAgIGNvbnN0IGludGVyc2VjdHMgPSByYXljYXN0ZXIuaW50ZXJzZWN0T2JqZWN0KG1lc2gpO1xuXG4gICAgICBpZiAoaW50ZXJzZWN0cy5sZW5ndGgpIHtcbiAgICAgICAgY29uc3QgeyB4LCB5IH0gPSBpbnRlcnNlY3RzWzBdLnBvaW50O1xuXG4gICAgICAgIHBvbHlnb25Qb2ludGVyLnBvc2l0aW9uLnNldCh4LCB5LCAwLjUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgeyB4LCB5IH0gPSBjbG9zZXN0UG9pbnRJblBvbHlnb24oXG5cbiAgICAgICAgICBwb2ludHMubWFwKCh7IHgsIHkgfSkgPT4gKHtcbiAgICAgICAgICAgIHg6IHggKyBwb3NpdGlvbi54LFxuICAgICAgICAgICAgeTogeSArIHBvc2l0aW9uLnksXG4gICAgICAgICAgfSkpLFxuICAgICAgICAgIHsgeDogbW91c2UueCwgeTogbW91c2UueSB9LFxuICAgICAgICApO1xuICAgICAgICBwb2x5Z29uUG9pbnRlci5wb3NpdGlvbi5zZXQoeCwgeSwgMC41KTtcbiAgICAgIH1cbiAgICB9KTtcblxuICB9XG5cbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgKHsgY2xpZW50WCwgY2xpZW50WSB9KSA9PiB7XG4gICAgbW91c2UueCA9IChjbGllbnRYIC8gd2luZG93V2lkdGggKiAxMDAgLSA1MCkgKiBhc3BlY3RSYXRpbztcbiAgICBtb3VzZS55ID0gLWNsaWVudFkgLyB3aW5kb3dIZWlnaHQgKiAxMDAgKyA1MDtcbiAgICBub3JtYWxpemVkTW91c2UueCA9ICggY2xpZW50WCAvIHdpbmRvd1dpZHRoICkgKiAyIC0gMTtcbiAgICBub3JtYWxpemVkTW91c2UueSA9IC0gKCBjbGllbnRZIC8gd2luZG93SGVpZ2h0ICkgKiAyICsgMTtcbiAgfSk7XG5cbiAgbG9vcCgpO1xufTtcbiJdfQ=="
    }
  ],
  "/Users/vadymrostok/code/pets/geometry-challenge/src/bootstrap.js": [
    "\"use strict\";\n\nvar _ClosestPointDemo = _interopRequireDefault(require(\"./ClosestPointDemo.js\"));\n\nfunction _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { \"default\": obj }; }\n\n(0, _ClosestPointDemo[\"default\"])();\n\nif (module.onReload) {\n  module.onReload(function () {\n    window.location.reload();\n  });\n}\n",
    {
      "./ClosestPointDemo.js": "/Users/vadymrostok/code/pets/geometry-challenge/src/ClosestPointDemo.js"
    },
    {
      "id": "/Users/vadymrostok/code/pets/geometry-challenge/src/bootstrap.js",
      "hash": "5Chw/Q",
      "browserifyId": 4,
      "sourcemap": "//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImJvb3RzdHJhcC5qcz92ZXJzaW9uPTVDaHcvUSJdLCJuYW1lcyI6WyJtb2R1bGUiLCJvblJlbG9hZCIsIndpbmRvdyIsImxvY2F0aW9uIiwicmVsb2FkIl0sIm1hcHBpbmdzIjoiOzs7QUFBQTs7OztBQUVBOztBQUVBLElBQUlBLE1BQU0sQ0FBQ0MsUUFBWCxFQUFxQjtBQUNuQkQsRUFBQUEsTUFBTSxDQUFDQyxRQUFQLENBQWdCLFlBQU07QUFDcEJDLElBQUFBLE1BQU0sQ0FBQ0MsUUFBUCxDQUFnQkMsTUFBaEI7QUFDRCxHQUZEO0FBR0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgQ2xvc2VzdFBvaW50RGVtbyBmcm9tICcuL0Nsb3Nlc3RQb2ludERlbW8uanMnO1xuXG5DbG9zZXN0UG9pbnREZW1vKCk7XG5cbmlmIChtb2R1bGUub25SZWxvYWQpIHtcbiAgbW9kdWxlLm9uUmVsb2FkKCgpID0+IHtcbiAgICB3aW5kb3cubG9jYXRpb24ucmVsb2FkKCk7XG4gIH0pO1xufVxuIl19"
    }
  ],
  "/Users/vadymrostok/code/pets/geometry-challenge/src/closestPointInPolygon.js": [
    "\"use strict\";\n\nObject.defineProperty(exports, \"__esModule\", {\n  value: true\n});\nexports[\"default\"] = closestPointInPolygon;\n\nvar _three = require(\"three\");\n\n// In order to reuse some object we'll initialize them here:\nvar segmentStartPoint = new _three.Vector3();\nvar segmentEndPoint = new _three.Vector3();\nvar targetPoint = new _three.Vector3();\nvar directionVector = new _three.Vector3();\nvar targetPointSubSegmentStartPoint = new _three.Vector3(); // let f = false\n\n/**\n * @param {{x: Number, y: Number}[]} points array of point objects\n * @returns {x: Number, y: Number} point object\n */\n\nfunction closestPointInPolygon(points, _ref) {\n  var targetPointX = _ref.x,\n      targetPointY = _ref.y;\n  var minimalDistance = Infinity;\n  var closestPoint = points[0];\n  points.reduce(function (previousPoint, currentPoint) {\n    // if (!f) {\n    //   console.log('currentPoint, previousPoint', currentPoint, previousPoint);\n    // }\n    segmentStartPoint.set(previousPoint.x, previousPoint.y, 0.0);\n    segmentEndPoint.set(currentPoint.x, currentPoint.y, 0.0);\n    targetPoint.set(targetPointX, targetPointY, 0);\n    directionVector.subVectors(segmentEndPoint, segmentStartPoint); // dot(targetPoint - segmentStartPoint, directionVector) / dot(directionVector, directionVector)\n\n    var closestSegmentIndex = directionVector.dot(targetPointSubSegmentStartPoint.subVectors(targetPoint, segmentStartPoint)) / directionVector.clone().dot(directionVector);\n    var distance = 0;\n    var intersect = new _three.Vector3();\n\n    if (closestSegmentIndex < 0) {\n      intersect = segmentStartPoint;\n      distance = targetPoint.clone().sub(segmentStartPoint).length();\n    } else if (closestSegmentIndex > 1) {\n      intersect.addVectors(segmentStartPoint, directionVector);\n      distance = targetPoint.clone().sub(segmentEndPoint).length();\n    } else {\n      intersect.addVectors(segmentStartPoint, directionVector.multiplyScalar(closestSegmentIndex));\n      distance = targetPoint.clone().sub(intersect).length();\n    }\n\n    ;\n\n    if (distance < minimalDistance) {\n      minimalDistance = distance;\n      closestPoint = {\n        x: intersect.x,\n        y: intersect.y\n      };\n    }\n\n    return currentPoint;\n  }); // f=true\n\n  return closestPoint;\n}\n",
    {
      "three": "/Users/vadymrostok/code/pets/geometry-challenge/node_modules/three/build/three.js"
    },
    {
      "id": "/Users/vadymrostok/code/pets/geometry-challenge/src/closestPointInPolygon.js",
      "hash": "K8eJlw",
      "browserifyId": 5,
      "sourcemap": "//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNsb3Nlc3RQb2ludEluUG9seWdvbi5qcz92ZXJzaW9uPUs4ZUpsdyJdLCJuYW1lcyI6WyJzZWdtZW50U3RhcnRQb2ludCIsIlZlY3RvcjMiLCJzZWdtZW50RW5kUG9pbnQiLCJ0YXJnZXRQb2ludCIsImRpcmVjdGlvblZlY3RvciIsInRhcmdldFBvaW50U3ViU2VnbWVudFN0YXJ0UG9pbnQiLCJjbG9zZXN0UG9pbnRJblBvbHlnb24iLCJwb2ludHMiLCJ0YXJnZXRQb2ludFgiLCJ4IiwidGFyZ2V0UG9pbnRZIiwieSIsIm1pbmltYWxEaXN0YW5jZSIsIkluZmluaXR5IiwiY2xvc2VzdFBvaW50IiwicmVkdWNlIiwicHJldmlvdXNQb2ludCIsImN1cnJlbnRQb2ludCIsInNldCIsInN1YlZlY3RvcnMiLCJjbG9zZXN0U2VnbWVudEluZGV4IiwiZG90IiwiY2xvbmUiLCJkaXN0YW5jZSIsImludGVyc2VjdCIsInN1YiIsImxlbmd0aCIsImFkZFZlY3RvcnMiLCJtdWx0aXBseVNjYWxhciJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7QUFBQTs7QUFFQTtBQUNBLElBQU1BLGlCQUFpQixHQUFHLElBQUlDLGNBQUosRUFBMUI7QUFDQSxJQUFNQyxlQUFlLEdBQUcsSUFBSUQsY0FBSixFQUF4QjtBQUNBLElBQU1FLFdBQVcsR0FBRyxJQUFJRixjQUFKLEVBQXBCO0FBQ0EsSUFBTUcsZUFBZSxHQUFHLElBQUlILGNBQUosRUFBeEI7QUFDQSxJQUFNSSwrQkFBK0IsR0FBRyxJQUFJSixjQUFKLEVBQXhDLEVBRUE7O0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBQ2UsU0FBU0sscUJBQVQsQ0FBK0JDLE1BQS9CLFFBQTZFO0FBQUEsTUFBakNDLFlBQWlDLFFBQXBDQyxDQUFvQztBQUFBLE1BQWhCQyxZQUFnQixRQUFuQkMsQ0FBbUI7QUFDMUYsTUFBSUMsZUFBZSxHQUFHQyxRQUF0QjtBQUNBLE1BQUlDLFlBQVksR0FBR1AsTUFBTSxDQUFDLENBQUQsQ0FBekI7QUFFQUEsRUFBQUEsTUFBTSxDQUFDUSxNQUFQLENBQWMsVUFBQ0MsYUFBRCxFQUFnQkMsWUFBaEIsRUFBaUM7QUFDN0M7QUFDQTtBQUNBO0FBRUFqQixJQUFBQSxpQkFBaUIsQ0FBQ2tCLEdBQWxCLENBQXNCRixhQUFhLENBQUNQLENBQXBDLEVBQXVDTyxhQUFhLENBQUNMLENBQXJELEVBQXlELEdBQXpEO0FBQ0FULElBQUFBLGVBQWUsQ0FBQ2dCLEdBQWhCLENBQW9CRCxZQUFZLENBQUNSLENBQWpDLEVBQW9DUSxZQUFZLENBQUNOLENBQWpELEVBQXFELEdBQXJEO0FBQ0FSLElBQUFBLFdBQVcsQ0FBQ2UsR0FBWixDQUFnQlYsWUFBaEIsRUFBOEJFLFlBQTlCLEVBQTRDLENBQTVDO0FBQ0FOLElBQUFBLGVBQWUsQ0FBQ2UsVUFBaEIsQ0FBMkJqQixlQUEzQixFQUE0Q0YsaUJBQTVDLEVBUjZDLENBVTdDOztBQUNBLFFBQU1vQixtQkFBbUIsR0FDbkJoQixlQUFlLENBQUNpQixHQUFoQixDQUFvQmhCLCtCQUErQixDQUFDYyxVQUFoQyxDQUEyQ2hCLFdBQTNDLEVBQXdESCxpQkFBeEQsQ0FBcEIsSUFDQUksZUFBZSxDQUFDa0IsS0FBaEIsR0FBd0JELEdBQXhCLENBQTRCakIsZUFBNUIsQ0FGTjtBQUlBLFFBQUltQixRQUFRLEdBQUcsQ0FBZjtBQUNBLFFBQUlDLFNBQVMsR0FBRyxJQUFJdkIsY0FBSixFQUFoQjs7QUFFQSxRQUFJbUIsbUJBQW1CLEdBQUcsQ0FBMUIsRUFBNkI7QUFDM0JJLE1BQUFBLFNBQVMsR0FBR3hCLGlCQUFaO0FBQ0F1QixNQUFBQSxRQUFRLEdBQUdwQixXQUFXLENBQUNtQixLQUFaLEdBQW9CRyxHQUFwQixDQUF3QnpCLGlCQUF4QixFQUEyQzBCLE1BQTNDLEVBQVg7QUFDRCxLQUhELE1BR08sSUFBSU4sbUJBQW1CLEdBQUcsQ0FBMUIsRUFBNkI7QUFDbENJLE1BQUFBLFNBQVMsQ0FBQ0csVUFBVixDQUFxQjNCLGlCQUFyQixFQUF3Q0ksZUFBeEM7QUFDQW1CLE1BQUFBLFFBQVEsR0FBR3BCLFdBQVcsQ0FBQ21CLEtBQVosR0FBb0JHLEdBQXBCLENBQXdCdkIsZUFBeEIsRUFBeUN3QixNQUF6QyxFQUFYO0FBQ0QsS0FITSxNQUdBO0FBQ0xGLE1BQUFBLFNBQVMsQ0FBQ0csVUFBVixDQUFxQjNCLGlCQUFyQixFQUF3Q0ksZUFBZSxDQUFDd0IsY0FBaEIsQ0FBK0JSLG1CQUEvQixDQUF4QztBQUNBRyxNQUFBQSxRQUFRLEdBQUdwQixXQUFXLENBQUNtQixLQUFaLEdBQW9CRyxHQUFwQixDQUF3QkQsU0FBeEIsRUFBbUNFLE1BQW5DLEVBQVg7QUFDRDs7QUFBQTs7QUFFRCxRQUFJSCxRQUFRLEdBQUdYLGVBQWYsRUFBZ0M7QUFDOUJBLE1BQUFBLGVBQWUsR0FBR1csUUFBbEI7QUFDQVQsTUFBQUEsWUFBWSxHQUFHO0FBQUVMLFFBQUFBLENBQUMsRUFBRWUsU0FBUyxDQUFDZixDQUFmO0FBQWtCRSxRQUFBQSxDQUFDLEVBQUVhLFNBQVMsQ0FBQ2I7QUFBL0IsT0FBZjtBQUNEOztBQUVELFdBQU9NLFlBQVA7QUFDRCxHQW5DRCxFQUowRixDQXdDMUY7O0FBRUEsU0FBT0gsWUFBUDtBQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgVmVjdG9yMyB9IGZyb20gJ3RocmVlJztcblxuLy8gSW4gb3JkZXIgdG8gcmV1c2Ugc29tZSBvYmplY3Qgd2UnbGwgaW5pdGlhbGl6ZSB0aGVtIGhlcmU6XG5jb25zdCBzZWdtZW50U3RhcnRQb2ludCA9IG5ldyBWZWN0b3IzKCk7XG5jb25zdCBzZWdtZW50RW5kUG9pbnQgPSBuZXcgVmVjdG9yMygpO1xuY29uc3QgdGFyZ2V0UG9pbnQgPSBuZXcgVmVjdG9yMygpO1xuY29uc3QgZGlyZWN0aW9uVmVjdG9yID0gbmV3IFZlY3RvcjMoKTtcbmNvbnN0IHRhcmdldFBvaW50U3ViU2VnbWVudFN0YXJ0UG9pbnQgPSBuZXcgVmVjdG9yMygpO1xuXG4vLyBsZXQgZiA9IGZhbHNlXG4vKipcbiAqIEBwYXJhbSB7e3g6IE51bWJlciwgeTogTnVtYmVyfVtdfSBwb2ludHMgYXJyYXkgb2YgcG9pbnQgb2JqZWN0c1xuICogQHJldHVybnMge3g6IE51bWJlciwgeTogTnVtYmVyfSBwb2ludCBvYmplY3RcbiAqL1xuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gY2xvc2VzdFBvaW50SW5Qb2x5Z29uKHBvaW50cywgeyB4OiB0YXJnZXRQb2ludFgsIHk6IHRhcmdldFBvaW50WSB9KSB7XG4gIGxldCBtaW5pbWFsRGlzdGFuY2UgPSBJbmZpbml0eTtcbiAgbGV0IGNsb3Nlc3RQb2ludCA9IHBvaW50c1swXTtcblxuICBwb2ludHMucmVkdWNlKChwcmV2aW91c1BvaW50LCBjdXJyZW50UG9pbnQpID0+IHtcbiAgICAvLyBpZiAoIWYpIHtcbiAgICAvLyAgIGNvbnNvbGUubG9nKCdjdXJyZW50UG9pbnQsIHByZXZpb3VzUG9pbnQnLCBjdXJyZW50UG9pbnQsIHByZXZpb3VzUG9pbnQpO1xuICAgIC8vIH1cbiAgICBcbiAgICBzZWdtZW50U3RhcnRQb2ludC5zZXQocHJldmlvdXNQb2ludC54LCBwcmV2aW91c1BvaW50LnksICAwLjApO1xuICAgIHNlZ21lbnRFbmRQb2ludC5zZXQoY3VycmVudFBvaW50LngsIGN1cnJlbnRQb2ludC55LCAgMC4wKTtcbiAgICB0YXJnZXRQb2ludC5zZXQodGFyZ2V0UG9pbnRYLCB0YXJnZXRQb2ludFksIDApO1xuICAgIGRpcmVjdGlvblZlY3Rvci5zdWJWZWN0b3JzKHNlZ21lbnRFbmRQb2ludCwgc2VnbWVudFN0YXJ0UG9pbnQpO1xuXG4gICAgLy8gZG90KHRhcmdldFBvaW50IC0gc2VnbWVudFN0YXJ0UG9pbnQsIGRpcmVjdGlvblZlY3RvcikgLyBkb3QoZGlyZWN0aW9uVmVjdG9yLCBkaXJlY3Rpb25WZWN0b3IpXG4gICAgY29uc3QgY2xvc2VzdFNlZ21lbnRJbmRleCA9IFxuICAgICAgICAgIGRpcmVjdGlvblZlY3Rvci5kb3QodGFyZ2V0UG9pbnRTdWJTZWdtZW50U3RhcnRQb2ludC5zdWJWZWN0b3JzKHRhcmdldFBvaW50LCBzZWdtZW50U3RhcnRQb2ludCkpIC9cbiAgICAgICAgICBkaXJlY3Rpb25WZWN0b3IuY2xvbmUoKS5kb3QoZGlyZWN0aW9uVmVjdG9yKTtcblxuICAgIGxldCBkaXN0YW5jZSA9IDA7XG4gICAgbGV0IGludGVyc2VjdCA9IG5ldyBWZWN0b3IzKCk7XG5cbiAgICBpZiAoY2xvc2VzdFNlZ21lbnRJbmRleCA8IDApIHtcbiAgICAgIGludGVyc2VjdCA9IHNlZ21lbnRTdGFydFBvaW50O1xuICAgICAgZGlzdGFuY2UgPSB0YXJnZXRQb2ludC5jbG9uZSgpLnN1YihzZWdtZW50U3RhcnRQb2ludCkubGVuZ3RoKCk7XG4gICAgfSBlbHNlIGlmIChjbG9zZXN0U2VnbWVudEluZGV4ID4gMSkge1xuICAgICAgaW50ZXJzZWN0LmFkZFZlY3RvcnMoc2VnbWVudFN0YXJ0UG9pbnQsIGRpcmVjdGlvblZlY3Rvcik7XG4gICAgICBkaXN0YW5jZSA9IHRhcmdldFBvaW50LmNsb25lKCkuc3ViKHNlZ21lbnRFbmRQb2ludCkubGVuZ3RoKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGludGVyc2VjdC5hZGRWZWN0b3JzKHNlZ21lbnRTdGFydFBvaW50LCBkaXJlY3Rpb25WZWN0b3IubXVsdGlwbHlTY2FsYXIoY2xvc2VzdFNlZ21lbnRJbmRleCkpO1xuICAgICAgZGlzdGFuY2UgPSB0YXJnZXRQb2ludC5jbG9uZSgpLnN1YihpbnRlcnNlY3QpLmxlbmd0aCgpO1xuICAgIH07XG5cbiAgICBpZiAoZGlzdGFuY2UgPCBtaW5pbWFsRGlzdGFuY2UpIHtcbiAgICAgIG1pbmltYWxEaXN0YW5jZSA9IGRpc3RhbmNlO1xuICAgICAgY2xvc2VzdFBvaW50ID0geyB4OiBpbnRlcnNlY3QueCwgeTogaW50ZXJzZWN0LnkgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gY3VycmVudFBvaW50O1xuICB9KTtcbiAgLy8gZj10cnVlXG5cbiAgcmV0dXJuIGNsb3Nlc3RQb2ludDtcbn1cbiJdfQ=="
    }
  ],
  "/Users/vadymrostok/code/pets/geometry-challenge/src/stats.js": [
    "\"use strict\";\n\nObject.defineProperty(exports, \"__esModule\", {\n  value: true\n});\nexports[\"default\"] = void 0;\n\nvar Stats = function Stats() {\n  var mode = 0;\n  var container = document.createElement('div');\n  container.style.cssText = 'position:fixed;top:0;left:0;cursor:pointer;opacity:0.9;z-index:10000';\n  container.addEventListener('click', function (event) {\n    event.preventDefault();\n    showPanel(++mode % container.children.length);\n  }, false); //\n\n  function addPanel(panel) {\n    container.appendChild(panel.dom);\n    return panel;\n  }\n\n  function showPanel(id) {\n    for (var i = 0; i < container.children.length; i++) {\n      container.children[i].style.display = i === id ? 'block' : 'none';\n    }\n\n    mode = id;\n  } //\n\n\n  var beginTime = (performance || Date).now(),\n      prevTime = beginTime,\n      frames = 0;\n  var fpsPanel = addPanel(new Stats.Panel('FPS', '#0ff', '#002'));\n  var msPanel = addPanel(new Stats.Panel('MS', '#0f0', '#020'));\n\n  if (self.performance && self.performance.memory) {\n    var memPanel = addPanel(new Stats.Panel('MB', '#f08', '#201'));\n  }\n\n  showPanel(0);\n  return {\n    REVISION: 16,\n    dom: container,\n    addPanel: addPanel,\n    showPanel: showPanel,\n    begin: function begin() {\n      beginTime = (performance || Date).now();\n    },\n    end: function end() {\n      frames++;\n      var time = (performance || Date).now();\n      msPanel.update(time - beginTime, 200);\n\n      if (time >= prevTime + 1000) {\n        fpsPanel.update(frames * 1000 / (time - prevTime), 100);\n        prevTime = time;\n        frames = 0;\n\n        if (memPanel) {\n          var memory = performance.memory;\n          memPanel.update(memory.usedJSHeapSize / 1048576, memory.jsHeapSizeLimit / 1048576);\n        }\n      }\n\n      return time;\n    },\n    update: function update() {\n      beginTime = this.end();\n    },\n    // Backwards Compatibility\n    domElement: container,\n    setMode: showPanel\n  };\n};\n\nStats.Panel = function (name, fg, bg) {\n  var min = Infinity,\n      max = 0,\n      round = Math.round;\n  var PR = round(window.devicePixelRatio || 1);\n  var WIDTH = 80 * PR,\n      HEIGHT = 48 * PR,\n      TEXT_X = 3 * PR,\n      TEXT_Y = 2 * PR,\n      GRAPH_X = 3 * PR,\n      GRAPH_Y = 15 * PR,\n      GRAPH_WIDTH = 74 * PR,\n      GRAPH_HEIGHT = 30 * PR;\n  var canvas = document.createElement('canvas');\n  canvas.width = WIDTH;\n  canvas.height = HEIGHT;\n  canvas.style.cssText = 'width:80px;height:48px';\n  var context = canvas.getContext('2d');\n  context.font = 'bold ' + 9 * PR + 'px Helvetica,Arial,sans-serif';\n  context.textBaseline = 'top';\n  context.fillStyle = bg;\n  context.fillRect(0, 0, WIDTH, HEIGHT);\n  context.fillStyle = fg;\n  context.fillText(name, TEXT_X, TEXT_Y);\n  context.fillRect(GRAPH_X, GRAPH_Y, GRAPH_WIDTH, GRAPH_HEIGHT);\n  context.fillStyle = bg;\n  context.globalAlpha = 0.9;\n  context.fillRect(GRAPH_X, GRAPH_Y, GRAPH_WIDTH, GRAPH_HEIGHT);\n  return {\n    dom: canvas,\n    update: function update(value, maxValue) {\n      min = Math.min(min, value);\n      max = Math.max(max, value);\n      context.fillStyle = bg;\n      context.globalAlpha = 1;\n      context.fillRect(0, 0, WIDTH, GRAPH_Y);\n      context.fillStyle = fg;\n      context.fillText(round(value) + ' ' + name + ' (' + round(min) + '-' + round(max) + ')', TEXT_X, TEXT_Y);\n      context.drawImage(canvas, GRAPH_X + PR, GRAPH_Y, GRAPH_WIDTH - PR, GRAPH_HEIGHT, GRAPH_X, GRAPH_Y, GRAPH_WIDTH - PR, GRAPH_HEIGHT);\n      context.fillRect(GRAPH_X + GRAPH_WIDTH - PR, GRAPH_Y, PR, GRAPH_HEIGHT);\n      context.fillStyle = bg;\n      context.globalAlpha = 0.9;\n      context.fillRect(GRAPH_X + GRAPH_WIDTH - PR, GRAPH_Y, PR, round((1 - value / maxValue) * GRAPH_HEIGHT));\n    }\n  };\n};\n\nvar _default = Stats;\nexports[\"default\"] = _default;\n",
    {},
    {
      "id": "/Users/vadymrostok/code/pets/geometry-challenge/src/stats.js",
      "hash": "J1PI4A",
      "browserifyId": 6,
      "sourcemap": "//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInN0YXRzLmpzP3ZlcnNpb249SjFQSTRBIl0sIm5hbWVzIjpbIlN0YXRzIiwibW9kZSIsImNvbnRhaW5lciIsImRvY3VtZW50IiwiY3JlYXRlRWxlbWVudCIsInN0eWxlIiwiY3NzVGV4dCIsImFkZEV2ZW50TGlzdGVuZXIiLCJldmVudCIsInByZXZlbnREZWZhdWx0Iiwic2hvd1BhbmVsIiwiY2hpbGRyZW4iLCJsZW5ndGgiLCJhZGRQYW5lbCIsInBhbmVsIiwiYXBwZW5kQ2hpbGQiLCJkb20iLCJpZCIsImkiLCJkaXNwbGF5IiwiYmVnaW5UaW1lIiwicGVyZm9ybWFuY2UiLCJEYXRlIiwibm93IiwicHJldlRpbWUiLCJmcmFtZXMiLCJmcHNQYW5lbCIsIlBhbmVsIiwibXNQYW5lbCIsInNlbGYiLCJtZW1vcnkiLCJtZW1QYW5lbCIsIlJFVklTSU9OIiwiYmVnaW4iLCJlbmQiLCJ0aW1lIiwidXBkYXRlIiwidXNlZEpTSGVhcFNpemUiLCJqc0hlYXBTaXplTGltaXQiLCJkb21FbGVtZW50Iiwic2V0TW9kZSIsIm5hbWUiLCJmZyIsImJnIiwibWluIiwiSW5maW5pdHkiLCJtYXgiLCJyb3VuZCIsIk1hdGgiLCJQUiIsIndpbmRvdyIsImRldmljZVBpeGVsUmF0aW8iLCJXSURUSCIsIkhFSUdIVCIsIlRFWFRfWCIsIlRFWFRfWSIsIkdSQVBIX1giLCJHUkFQSF9ZIiwiR1JBUEhfV0lEVEgiLCJHUkFQSF9IRUlHSFQiLCJjYW52YXMiLCJ3aWR0aCIsImhlaWdodCIsImNvbnRleHQiLCJnZXRDb250ZXh0IiwiZm9udCIsInRleHRCYXNlbGluZSIsImZpbGxTdHlsZSIsImZpbGxSZWN0IiwiZmlsbFRleHQiLCJnbG9iYWxBbHBoYSIsInZhbHVlIiwibWF4VmFsdWUiLCJkcmF3SW1hZ2UiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O0FBQUEsSUFBSUEsS0FBSyxHQUFHLFNBQVJBLEtBQVEsR0FBWTtBQUV2QixNQUFJQyxJQUFJLEdBQUcsQ0FBWDtBQUVBLE1BQUlDLFNB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QUNBb0IsTUFBQUEsT0FBTyxDQUFDTyxXQUFSLEdBQXNCLEdBQXRCO0FBQ0FQLE1BQUFBLE9BQU8sQ0FBQ0ssUUFBUixDQUFrQlosT0FBTyxHQUFHRSxXQUFWLEdBQXdCVCxFQUExQyxFQUE4Q1EsT0FBOUMsRUFBdURSLEVBQXZELEVBQTJERixLQUFLLENBQUUsQ0FBRSxJQUFNd0IsS0FBSyxHQUFHQyxRQUFoQixJQUErQmIsWUFBakMsQ0FBaEU7QUFFQTtBQXZCSyxHQUFQO0FBMkJBLENBekREOztlQTJEZTNEIiwic291cmNlc0NvbnRlbnQiOlsidmFyIFN0YXRzID0gZnVuY3Rpb24gKCkge1xuXG5cdHZhciBtb2RlID0gMDtcblxuXHR2YXIgY29udGFpbmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCggJ2RpdicgKTtcblx0Y29udGFpbmVyLnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7dG9wOjA7bGVmdDowO2N1cnNvcjpwb2ludGVyO29wYWNpdHk6MC45O3otaW5kZXg6MTAwMDAnO1xuXHRjb250YWluZXIuYWRkRXZlbnRMaXN0ZW5lciggJ2NsaWNrJywgZnVuY3Rpb24gKCBldmVudCApIHtcblxuXHRcdGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG5cdFx0c2hvd1BhbmVsKCArKyBtb2RlICUgY29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCApO1xuXG5cdH0sIGZhbHNlICk7XG5cblx0Ly9cblxuXHRmdW5jdGlvbiBhZGRQYW5lbCggcGFuZWwgKSB7XG5cblx0XHRjb250YWluZXIuYXBwZW5kQ2hpbGQoIHBhbmVsLmRvbSApO1xuXHRcdHJldHVybiBwYW5lbDtcblxuXHR9XG5cblx0ZnVuY3Rpb24gc2hvd1BhbmVsKCBpZCApIHtcblxuXHRcdGZvciAoIHZhciBpID0gMDsgaSA8IGNvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGg7IGkgKysgKSB7XG5cblx0XHRcdGNvbnRhaW5lci5jaGlsZHJlblsgaSBdLnN0eWxlLmRpc3BsYXkgPSBpID09PSBpZCA/ICdibG9jaycgOiAnbm9uZSc7XG5cblx0XHR9XG5cblx0XHRtb2RlID0gaWQ7XG5cblx0fVxuXG5cdC8vXG5cblx0dmFyIGJlZ2luVGltZSA9ICggcGVyZm9ybWFuY2UgfHwgRGF0ZSApLm5vdygpLCBwcmV2VGltZSA9IGJlZ2luVGltZSwgZnJhbWVzID0gMDtcblxuXHR2YXIgZnBzUGFuZWwgPSBhZGRQYW5lbCggbmV3IFN0YXRzLlBhbmVsKCAnRlBTJywgJyMwZmYnLCAnIzAwMicgKSApO1xuXHR2YXIgbXNQYW5lbCA9IGFkZFBhbmVsKCBuZXcgU3RhdHMuUGFuZWwoICdNUycsICcjMGYwJywgJyMwMjAnICkgKTtcblxuXHRpZiAoIHNlbGYucGVyZm9ybWFuY2UgJiYgc2VsZi5wZXJmb3JtYW5jZS5tZW1vcnkgKSB7XG5cblx0XHR2YXIgbWVtUGFuZWwgPSBhZGRQYW5lbCggbmV3IFN0YXRzLlBhbmVsKCAnTUInLCAnI2YwOCcsICcjMjAxJyApICk7XG5cblx0fVxuXG5cdHNob3dQYW5lbCggMCApO1xuXG5cdHJldHVybiB7XG5cblx0XHRSRVZJU0lPTjogMTYsXG5cblx0XHRkb206IGNvbnRhaW5lcixcblxuXHRcdGFkZFBhbmVsOiBhZGRQYW5lbCxcblx0XHRzaG93UGFuZWw6IHNob3dQYW5lbCxcblxuXHRcdGJlZ2luOiBmdW5jdGlvbiAoKSB7XG5cblx0XHRcdGJlZ2luVGltZSA9ICggcGVyZm9ybWFuY2UgfHwgRGF0ZSApLm5vdygpO1xuXG5cdFx0fSxcblxuXHRcdGVuZDogZnVuY3Rpb24gKCkge1xuXG5cdFx0XHRmcmFtZXMgKys7XG5cblx0XHRcdHZhciB0aW1lID0gKCBwZXJmb3JtYW5jZSB8fCBEYXRlICkubm93KCk7XG5cblx0XHRcdG1zUGFuZWwudXBkYXRlKCB0aW1lIC0gYmVnaW5UaW1lLCAyMDAgKTtcblxuXHRcdFx0aWYgKCB0aW1lID49IHByZXZUaW1lICsgMTAwMCApIHtcblxuXHRcdFx0XHRmcHNQYW5lbC51cGRhdGUoICggZnJhbWVzICogMTAwMCApIC8gKCB0aW1lIC0gcHJldlRpbWUgKSwgMTAwICk7XG5cblx0XHRcdFx0cHJldlRpbWUgPSB0aW1lO1xuXHRcdFx0XHRmcmFtZXMgPSAwO1xuXG5cdFx0XHRcdGlmICggbWVtUGFuZWwgKSB7XG5cblx0XHRcdFx0XHR2YXIgbWVtb3J5ID0gcGVyZm9ybWFuY2UubWVtb3J5O1xuXHRcdFx0XHRcdG1lbVBhbmVsLnVwZGF0ZSggbWVtb3J5LnVzZWRKU0hlYXBTaXplIC8gMTA0ODU3NiwgbWVtb3J5LmpzSGVhcFNpemVMaW1pdCAvIDEwNDg1NzYgKTtcblxuXHRcdFx0XHR9XG5cblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIHRpbWU7XG5cblx0XHR9LFxuXG5cdFx0dXBkYXRlOiBmdW5jdGlvbiAoKSB7XG5cblx0XHRcdGJlZ2luVGltZSA9IHRoaXMuZW5kKCk7XG5cblx0XHR9LFxuXG5cdFx0Ly8gQmFja3dhcmRzIENvbXBhdGliaWxpdHlcblxuXHRcdGRvbUVsZW1lbnQ6IGNvbnRhaW5lcixcblx0XHRzZXRNb2RlOiBzaG93UGFuZWxcblxuXHR9O1xuXG59O1xuXG5TdGF0cy5QYW5lbCA9IGZ1bmN0aW9uICggbmFtZSwgZmcsIGJnICkge1xuXG5cdHZhciBtaW4gPSBJbmZpbml0eSwgbWF4ID0gMCwgcm91bmQgPSBNYXRoLnJvdW5kO1xuXHR2YXIgUFIgPSByb3VuZCggd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMSApO1xuXG5cdHZhciBXSURUSCA9IDgwICogUFIsIEhFSUdIVCA9IDQ4ICogUFIsXG5cdFx0XHRURVhUX1ggPSAzICogUFIsIFRFWFRfWSA9IDIgKiBQUixcblx0XHRcdEdSQVBIX1ggPSAzICogUFIsIEdSQVBIX1kgPSAxNSAqIFBSLFxuXHRcdFx0R1JBUEhfV0lEVEggPSA3NCAqIFBSLCBHUkFQSF9IRUlHSFQgPSAzMCAqIFBSO1xuXG5cdHZhciBjYW52YXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCAnY2FudmFzJyApO1xuXHRjYW52YXMud2lkdGggPSBXSURUSDtcblx0Y2FudmFzLmhlaWdodCA9IEhFSUdIVDtcblx0Y2FudmFzLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6ODBweDtoZWlnaHQ6NDhweCc7XG5cblx0dmFyIGNvbnRleHQgPSBjYW52YXMuZ2V0Q29udGV4dCggJzJkJyApO1xuXHRjb250ZXh0LmZvbnQgPSAnYm9sZCAnICsgKCA5ICogUFIgKSArICdweCBIZWx2ZXRpY2EsQXJpYWwsc2Fucy1zZXJpZic7XG5cdGNvbnRleHQudGV4dEJhc2VsaW5lID0gJ3RvcCc7XG5cblx0Y29udGV4dC5maWxsU3R5bGUgPSBiZztcblx0Y29udGV4dC5maWxsUmVjdCggMCwgMCwgV0lEVEgsIEhFSUdIVCApO1xuXG5cdGNvbnRleHQuZmlsbFN0eWxlID0gZmc7XG5cdGNvbnRleHQuZmlsbFRleHQoIG5hbWUsIFRFWFRfWCwgVEVYVF9ZICk7XG5cdGNvbnRleHQuZmlsbFJlY3QoIEdSQVBIX1gsIEdSQVBIX1ksIEdSQVBIX1dJRFRILCBHUkFQSF9IRUlHSFQgKTtcblxuXHRjb250ZXh0LmZpbGxTdHlsZSA9IGJnO1xuXHRjb250ZXh0Lmdsb2JhbEFscGhhID0gMC45O1xuXHRjb250ZXh0LmZpbGxSZWN0KCBHUkFQSF9YLCBHUkFQSF9ZLCBHUkFQSF9XSURUSCwgR1JBUEhfSEVJR0hUICk7XG5cblx0cmV0dXJuIHtcblxuXHRcdGRvbTogY2FudmFzLFxuXG5cdFx0dXBkYXRlOiBmdW5jdGlvbiAoIHZhbHVlLCBtYXhWYWx1ZSApIHtcblxuXHRcdFx0bWluID0gTWF0aC5taW4oIG1pbiwgdmFsdWUgKTtcblx0XHRcdG1heCA9IE1hdGgubWF4KCBtYXgsIHZhbHVlICk7XG5cblx0XHRcdGNvbnRleHQuZmlsbFN0eWxlID0gYmc7XG5cdFx0XHRjb250ZXh0Lmdsb2JhbEFscGhhID0gMTtcblx0XHRcdGNvbnRleHQuZmlsbFJlY3QoIDAsIDAsIFdJRFRILCBHUkFQSF9ZICk7XG5cdFx0XHRjb250ZXh0LmZpbGxTdHlsZSA9IGZnO1xuXHRcdFx0Y29udGV4dC5maWxsVGV4dCggcm91bmQoIHZhbHVlICkgKyAnICcgKyBuYW1lICsgJyAoJyArIHJvdW5kKCBtaW4gKSArICctJyArIHJvdW5kKCBtYXggKSArICcpJywgVEVYVF9YLCBURVhUX1kgKTtcblxuXHRcdFx0Y29udGV4dC5kcmF3SW1hZ2UoIGNhbnZhcywgR1JBUEhfWCArIFBSLCBHUkFQSF9ZLCBHUkFQSF9XSURUSCAtIFBSLCBHUkFQSF9IRUlHSFQsIEdSQVBIX1gsIEdSQVBIX1ksIEdSQVBIX1dJRFRIIC0gUFIsIEdSQVBIX0hFSUdIVCApO1xuXG5cdFx0XHRjb250ZXh0LmZpbGxSZWN0KCBHUkFQSF9YICsgR1JBUEhfV0lEVEggLSBQUiwgR1JBUEhfWSwgUFIsIEdSQVBIX0hFSUdIVCApO1xuXG5cdFx0XHRjb250ZXh0LmZpbGxTdHlsZSA9IGJnO1xuXHRcdFx0Y29udGV4dC5nbG9iYWxBbHBoYSA9IDAuOTtcblx0XHRcdGNvbnRleHQuZmlsbFJlY3QoIEdSQVBIX1ggKyBHUkFQSF9XSURUSCAtIFBSLCBHUkFQSF9ZLCBQUiwgcm91bmQoICggMSAtICggdmFsdWUgLyBtYXhWYWx1ZSApICkgKiBHUkFQSF9IRUlHSFQgKSApO1xuXG5cdFx0fVxuXG5cdH07XG5cbn07XG5cbmV4cG9ydCBkZWZhdWx0IFN0YXRzO1xuIl19"
    }
  ]
}, [
  "/Users/vadymrostok/code/pets/geometry-challenge/src/bootstrap.js"
], {
  "nodeModulesRoot": "/Users/vadymrostok/code/pets/geometry-challenge/node_modules",
  "port": 4474,
  "host": null,
  "clientEnabled": true,
  "debug": false,
  "babel": true
});