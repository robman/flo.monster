// WebHarness Worker Bundle — self-contained agent worker
// This runs inside an opaque-origin iframe Worker and cannot import external modules.
//
// Sections:
//   1. State & Utilities
//   2. Parsers — SSE parser
//   3. Mappers — Anthropic and OpenAI SSE event mappers
//   4. Request Builders — OpenAI/Gemini request body construction
//   5. Streaming — async iterator over API response chunks
//   6. Tool Dispatch — executeToolCall and related helpers
//   7. Hook System — pre/post tool use, agent start/end hooks
//   8. Agentic Loop — main turn loop with streaming, tool execution, budgets
//   9. Message Handler — incoming postMessage dispatch

(function() {
  'use strict';

  // ===== 1. State & Utilities =====

  var paused = false;
  var stopped = false;
  var visible = false;  // Visibility state from shell
  var viewState = 'max';  // View state from shell: min, max, ui-only, chat-only
  var isMobile = false;  // Mobile viewport flag from shell
  var hubMode = false;   // Hub mode: route page events to hub instead of local loop
  var config = null;
  var nextReqId = 0;
  var activeHookTypes = [];
  var turnMessages = [];
  var loopRunning = false;

  // Pending request/response handlers
  var pendingResponses = {};  // id -> { resolve, reject }
  var streamHandlers = {};    // id -> { chunks: [], done: false, error: null, notify: null }

  // Event queue for DOM events arriving while loop is running
  var eventQueue = [];
  var MAX_EVENT_QUEUE_SIZE = 100;

  // Track pending ask IDs for agent_respond tool
  var pendingAskId = null;

  function generateId() {
    return 'req-' + (++nextReqId);
  }

  function emitEvent(event) {
    self.postMessage({ type: 'event', event: event });
  }

  // ===== 2. Parsers =====

  // ---- SSE Parser (inline) ----
  function createSSEParser() {
    var buffer = '';
    return {
      feed: function(chunk) {
        buffer += chunk;
        var events = [];
        var lines = buffer.split('\n');
        buffer = lines.pop() || ''; // last element might be incomplete
        var currentEvent = null;
        var currentData = [];
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line === '' || line === '\r') {
            // Empty line: dispatch event
            if (currentData.length > 0) {
              events.push({ event: currentEvent, data: currentData.join('\n') });
            }
            currentEvent = null;
            currentData = [];
          } else if (line.charAt(0) === ':') {
            // Comment, ignore
          } else if (line.indexOf('event:') === 0) {
            currentEvent = line.substring(6).trim();
          } else if (line.indexOf('data:') === 0) {
            currentData.push(line.substring(5).trimStart());
          } else if (line.indexOf('event: ') === 0) {
            currentEvent = line.substring(7);
          } else if (line.indexOf('data: ') === 0) {
            currentData.push(line.substring(6));
          }
        }
        return events;
      },
      reset: function() {
        buffer = '';
      }
    };
  }

  // ===== 3. Mappers =====

  // ---- Anthropic Event Mapper (inline) ----
  function createEventMapper() {
    var currentToolId = null;
    var currentToolName = null;
    var toolInputAccum = '';
    var textAccum = '';

    return {
      mapSSEEvent: function(sseEvent) {
        if (!sseEvent.data || sseEvent.data === '[DONE]') return [];
        var parsed;
        try { parsed = JSON.parse(sseEvent.data); } catch(e) { return []; }
        var events = [];

        switch (parsed.type) {
          case 'message_start':
            events.push({ type: 'message_start', messageId: (parsed.message && parsed.message.id) || '' });
            if (parsed.message && parsed.message.usage) {
              events.push({
                type: 'usage',
                usage: { input_tokens: parsed.message.usage.input_tokens || 0, output_tokens: parsed.message.usage.output_tokens || 0 },
                cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' }
              });
            }
            break;

          case 'content_block_start':
            var block = parsed.content_block;
            if (block && block.type === 'text') {
              textAccum = '';
            } else if (block && block.type === 'tool_use') {
              currentToolId = block.id;
              currentToolName = block.name;
              toolInputAccum = '';
              events.push({ type: 'tool_use_start', toolUseId: block.id, toolName: block.name });
            }
            break;

          case 'content_block_delta':
            var delta = parsed.delta;
            if (delta && delta.type === 'text_delta') {
              textAccum += delta.text;
              events.push({ type: 'text_delta', text: delta.text });
            } else if (delta && delta.type === 'input_json_delta') {
              toolInputAccum += delta.partial_json;
              events.push({ type: 'tool_use_input_delta', toolUseId: currentToolId || '', partialJson: delta.partial_json });
            }
            break;

          case 'content_block_stop':
            if (currentToolId) {
              var input = {};
              try { input = JSON.parse(toolInputAccum); } catch(e) {}
              events.push({ type: 'tool_use_done', toolUseId: currentToolId, toolName: currentToolName || '', input: input });
              currentToolId = null;
              currentToolName = null;
              toolInputAccum = '';
            } else if (textAccum) {
              events.push({ type: 'text_done', text: textAccum });
              textAccum = '';
            }
            break;

          case 'message_delta':
            if (parsed.usage) {
              events.push({
                type: 'usage',
                usage: { input_tokens: parsed.usage.input_tokens || 0, output_tokens: parsed.usage.output_tokens || 0 },
                cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' }
              });
            }
            if (parsed.delta && parsed.delta.stop_reason) {
              // If max_tokens truncated a tool call in progress, flush it as an error
              if (parsed.delta.stop_reason === 'max_tokens' && currentToolId) {
                events.push({ type: 'tool_use_done', toolUseId: currentToolId, toolName: currentToolName || '', input: { _truncated: true }, truncated: true });
                currentToolId = null;
                currentToolName = null;
                toolInputAccum = '';
              }
              events.push({ type: 'turn_end', stopReason: parsed.delta.stop_reason });
            }
            break;

          case 'message_stop':
            // Redundant, ignore
            break;
        }
        return events;
      },
      reset: function() {
        currentToolId = null;
        currentToolName = null;
        toolInputAccum = '';
        textAccum = '';
      }
    };
  }

  // ---- OpenAI Event Mapper (inline) ----
  function createOpenAIEventMapper() {
    var activeToolCalls = {};  // keyed by index
    var textAccum = '';

    function flushText(events) {
      if (textAccum) {
        events.push({ type: 'text_done', text: textAccum });
        textAccum = '';
      }
    }

    function flushToolCalls(events) {
      var indices = Object.keys(activeToolCalls);
      for (var i = 0; i < indices.length; i++) {
        var idx = indices[i];
        var tc = activeToolCalls[idx];
        var input = {};
        try { input = JSON.parse(tc.arguments); } catch(e) {}
        events.push({ type: 'tool_use_done', toolUseId: tc.id, toolName: tc.name, input: input });
      }
      activeToolCalls = {};
    }

    return {
      mapSSEEvent: function(sseEvent) {
        if (!sseEvent.data || sseEvent.data === '[DONE]') return [];
        var parsed;
        try { parsed = JSON.parse(sseEvent.data); } catch(e) { return []; }
        var events = [];

        // Usage object (may appear in final chunk or standalone)
        if (parsed.usage) {
          events.push({
            type: 'usage',
            usage: {
              input_tokens: parsed.usage.prompt_tokens || 0,
              output_tokens: parsed.usage.completion_tokens || 0
            },
            cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' }
          });
        }

        // Check for choices
        if (parsed.choices && parsed.choices.length > 0) {
          var choice = parsed.choices[0];
          var delta = choice.delta;

          if (delta) {
            // Text content
            if (delta.content) {
              textAccum += delta.content;
              events.push({ type: 'text_delta', text: delta.content });
            }

            // Tool calls
            if (delta.tool_calls) {
              // Flush any pending text before tool calls
              flushText(events);

              for (var t = 0; t < delta.tool_calls.length; t++) {
                var tc = delta.tool_calls[t];
                var idx = String(tc.index);

                if (!activeToolCalls.hasOwnProperty(idx)) {
                  // New tool call
                  activeToolCalls[idx] = {
                    id: tc.id || '',
                    name: (tc.function && tc.function.name) || '',
                    arguments: ''
                  };
                  events.push({
                    type: 'tool_use_start',
                    toolUseId: activeToolCalls[idx].id,
                    toolName: activeToolCalls[idx].name
                  });
                }

                // Accumulate arguments
                if (tc.function && tc.function.arguments) {
                  activeToolCalls[idx].arguments += tc.function.arguments;
                  events.push({
                    type: 'tool_use_input_delta',
                    toolUseId: activeToolCalls[idx].id,
                    partialJson: tc.function.arguments
                  });
                }
              }
            }
          }

          // Finish reason
          if (choice.finish_reason) {
            flushText(events);
            flushToolCalls(events);

            var stopReason = 'end_turn';
            if (choice.finish_reason === 'stop') {
              stopReason = 'end_turn';
            } else if (choice.finish_reason === 'tool_calls') {
              stopReason = 'tool_use';
            } else if (choice.finish_reason === 'length') {
              stopReason = 'max_tokens';
            }
            events.push({ type: 'turn_end', stopReason: stopReason });
          }
        } else if (parsed.id && (!parsed.choices || parsed.choices.length === 0)) {
          // First chunk with id but no choices → message_start
          events.push({ type: 'message_start', messageId: parsed.id || '' });
        }

        return events;
      },
      reset: function() {
        activeToolCalls = {};
        textAccum = '';
      }
    };
  }

  // ---- Gemini Event Mapper (inline) ----
  function createGeminiEventMapper() {
    var toolCallCounter = 0;
    var textAccum = '';
    var hasText = false;
    var hadToolCalls = false;  // Stateful across chunks — Gemini can split functionCall and finishReason into separate chunks

    function flushText(events) {
      if (hasText && textAccum) {
        events.push({ type: 'text_done', text: textAccum });
        textAccum = '';
        hasText = false;
      }
    }

    return {
      mapSSEEvent: function(sseEvent) {
        if (!sseEvent.data) return [];
        var parsed;
        try { parsed = JSON.parse(sseEvent.data); } catch(e) { return []; }
        var events = [];

        var candidates = parsed.candidates;
        if (candidates && candidates.length > 0) {
          var candidate = candidates[0];
          var content = candidate.content;
          var parts = content && content.parts;

          if (parts) {
            for (var i = 0; i < parts.length; i++) {
              var part = parts[i];

              // Skip thinking parts
              if (part.thought === true && typeof part.text === 'string') {
                continue;
              }

              if (typeof part.text === 'string') {
                if (!hasText) {
                  hasText = true;
                  textAccum = '';
                }
                textAccum += part.text;
                events.push({ type: 'text_delta', text: part.text });
              }

              if (part.functionCall) {
                hadToolCalls = true;
                flushText(events);

                var fc = part.functionCall;
                var name = fc.name;
                var args = fc.args || {};
                var id = 'gemini_tc_' + (toolCallCounter++);

                events.push({ type: 'tool_use_start', toolUseId: id, toolName: name });
                events.push({ type: 'tool_use_input_delta', toolUseId: id, partialJson: JSON.stringify(args) });

                var doneEvent = { type: 'tool_use_done', toolUseId: id, toolName: name, input: args };
                if (part.thoughtSignature) {
                  doneEvent.thoughtSignature = part.thoughtSignature;
                }
                events.push(doneEvent);
              }
            }
          }

          var finishReason = candidate.finishReason;
          if (finishReason) {
            flushText(events);

            if (finishReason === 'STOP') {
              events.push({ type: 'turn_end', stopReason: hadToolCalls ? 'tool_use' : 'end_turn' });
            } else if (finishReason === 'MAX_TOKENS') {
              events.push({ type: 'turn_end', stopReason: 'max_tokens' });
            } else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
              events.push({ type: 'error', error: 'Gemini blocked response: ' + finishReason });
              events.push({ type: 'turn_end', stopReason: 'end_turn' });
            }
          }
        }

        // Usage metadata
        if (parsed.usageMetadata) {
          events.push({
            type: 'usage',
            usage: {
              input_tokens: parsed.usageMetadata.promptTokenCount || 0,
              output_tokens: parsed.usageMetadata.candidatesTokenCount || 0
            },
            cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' }
          });
        }

        return events;
      },
      reset: function() {
        toolCallCounter = 0;
        textAccum = '';
        hasText = false;
        hadToolCalls = false;
      }
    };
  }

  // ===== 4. Request Builders =====

  // ---- Gemini Schema Sanitizer ----
  function sanitizeSchemaForGemini(schema) {
    if (typeof schema !== 'object' || schema === null) return schema;
    var result = {};
    var keys = Object.keys(schema);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === 'additionalProperties') continue;
      if (keys[i] === 'properties' && typeof schema[keys[i]] === 'object') {
        var props = {};
        var propKeys = Object.keys(schema[keys[i]]);
        for (var j = 0; j < propKeys.length; j++) {
          props[propKeys[j]] = sanitizeSchemaForGemini(schema[keys[i]][propKeys[j]]);
        }
        result.properties = props;
      } else if (keys[i] === 'items' && typeof schema[keys[i]] === 'object') {
        result.items = sanitizeSchemaForGemini(schema[keys[i]]);
      } else {
        result[keys[i]] = schema[keys[i]];
      }
    }
    return result;
  }

  // ---- Gemini Schema Converter (uppercase types, strip additionalProperties, ensure properties on objects) ----
  function convertSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    var result = {};
    var keys = Object.keys(schema);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === 'additionalProperties') continue;
      result[keys[i]] = schema[keys[i]];
    }
    // Uppercase type
    if (typeof result.type === 'string') {
      result.type = result.type.toUpperCase();
    }
    // Bare objects need properties
    if (result.type === 'OBJECT' && !result.properties) {
      result.properties = {};
    }
    // Recurse into properties
    if (result.properties && typeof result.properties === 'object') {
      var newProps = {};
      var propKeys = Object.keys(result.properties);
      for (var j = 0; j < propKeys.length; j++) {
        if (typeof result.properties[propKeys[j]] === 'object' && result.properties[propKeys[j]] !== null) {
          newProps[propKeys[j]] = convertSchemaForGemini(result.properties[propKeys[j]]);
        } else {
          newProps[propKeys[j]] = result.properties[propKeys[j]];
        }
      }
      result.properties = newProps;
    }
    // Recurse into items
    if (result.items && typeof result.items === 'object') {
      result.items = convertSchemaForGemini(result.items);
    }
    return result;
  }

  // ---- Text-based Tool Call Fallback Parser ----
  // Some models (Gemini 3 previews) output tool calls as text like "toolname\n{json}"
  // instead of structured functionCall parts. Detect and convert to proper tool_use blocks.
  function parseTextToolCalls(contentBlocks, toolNames) {
    var results = [];
    for (var i = 0; i < contentBlocks.length; i++) {
      var block = contentBlocks[i];
      if (block.type !== 'text') continue;
      var text = block.text.trim();

      for (var n = 0; n < toolNames.length; n++) {
        var name = toolNames[n];
        // Pattern 1: "toolname\n{...}" (tool name on separate line)
        var prefix = name + '\n';
        if (text.startsWith(prefix)) {
          var jsonStr = text.slice(prefix.length).trim();
          var input = tryParseJsonObj(jsonStr);
          if (input !== null) {
            results.push({
              type: 'tool_use',
              id: 'text_tool_' + Date.now() + '_' + results.length,
              name: name,
              input: input,
            });
            break;
          }
        }
        // Pattern 2: tool name appears anywhere followed by \n{...}
        var idx = text.indexOf(name + '\n');
        if (idx >= 0) {
          var afterName = text.slice(idx + name.length + 1).trim();
          var extracted = extractJsonObj(afterName);
          if (extracted) {
            var parsed = tryParseJsonObj(extracted);
            if (parsed !== null) {
              results.push({
                type: 'tool_use',
                id: 'text_tool_' + Date.now() + '_' + results.length,
                name: name,
                input: parsed,
              });
              break;
            }
          }
        }
      }
    }
    return results;
  }

  function tryParseJsonObj(str) {
    try {
      var parsed = JSON.parse(str);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch(e) {}
    return null;
  }

  function extractJsonObj(str) {
    if (!str.startsWith('{')) return null;
    var depth = 0;
    var inString = false;
    var escape = false;
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) return str.slice(0, i + 1); }
    }
    return null;
  }

  // ---- OpenAI Request Body Builder ----
  function buildOpenAIRequestBody(agentConfig, messages, tools) {
    var openaiMessages = [];

    // System prompt as first message
    if (agentConfig.systemPrompt) {
      openaiMessages.push({ role: 'system', content: agentConfig.systemPrompt });
    }

    // Convert each message
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (msg.role === 'user') {
        // Separate tool_result blocks from text blocks
        var toolResults = [];
        var textParts = [];
        for (var c = 0; c < msg.content.length; c++) {
          if (msg.content[c].type === 'tool_result') toolResults.push(msg.content[c]);
          else if (msg.content[c].type === 'text') textParts.push(msg.content[c].text);
        }
        // tool_result → {role: "tool", tool_call_id, content}
        for (var tr = 0; tr < toolResults.length; tr++) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: toolResults[tr].tool_use_id,
            content: typeof toolResults[tr].content === 'string' ? toolResults[tr].content : JSON.stringify(toolResults[tr].content)
          });
        }
        // text → {role: "user", content}
        if (textParts.length > 0) {
          openaiMessages.push({ role: 'user', content: textParts.join('\n') });
        }
      } else if (msg.role === 'assistant') {
        var assistantText = [];
        var assistantToolCalls = [];
        for (var a = 0; a < msg.content.length; a++) {
          if (msg.content[a].type === 'text') {
            assistantText.push(msg.content[a].text);
          } else if (msg.content[a].type === 'tool_use') {
            assistantToolCalls.push({
              id: msg.content[a].id,
              type: 'function',
              function: {
                name: msg.content[a].name,
                arguments: JSON.stringify(msg.content[a].input)
              }
            });
          }
        }
        var assistantMsg = { role: 'assistant', content: assistantText.length > 0 ? assistantText.join('\n') : null };
        if (assistantToolCalls.length > 0) assistantMsg.tool_calls = assistantToolCalls;
        openaiMessages.push(assistantMsg);
      }
    }

    var body = {
      model: agentConfig.model,
      max_completion_tokens: agentConfig.maxTokens || 4096,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true }
    };

    if (tools && tools.length > 0) {
      var provider = agentConfig.provider || 'openai';
      body.tools = tools.map(function(t) {
        var schema = t.input_schema;
        // Sanitize for Gemini (strip additionalProperties)
        if (provider === 'gemini') {
          schema = sanitizeSchemaForGemini(schema);
        }
        return {
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: schema
          }
        };
      });
    }

    return body;
  }

  // ---- Gemini Request Body Builder ----
  function buildGeminiRequestBody(agentConfig, messages, tools) {
    var contents = [];
    // Track tool_use IDs to names for functionResponse
    var lastToolUses = {};

    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var role = msg.role === 'assistant' ? 'model' : 'user';
      var parts = [];

      if (msg.role === 'assistant') {
        var newToolUses = {};
        for (var c = 0; c < msg.content.length; c++) {
          var block = msg.content[c];
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            newToolUses[block.id] = block.name;
            var fcPart = { functionCall: { name: block.name, args: block.input } };
            if (block.thoughtSignature) {
              fcPart.thoughtSignature = block.thoughtSignature;
            }
            parts.push(fcPart);
          }
        }
        lastToolUses = newToolUses;
      } else {
        // User message
        for (var c2 = 0; c2 < msg.content.length; c2++) {
          var block2 = msg.content[c2];
          if (block2.type === 'text') {
            parts.push({ text: block2.text });
          } else if (block2.type === 'tool_result') {
            var name = lastToolUses[block2.tool_use_id] || 'unknown';
            var contentStr = typeof block2.content === 'string' ? block2.content : JSON.stringify(block2.content);
            var response;
            if (block2.is_error) {
              response = { error: contentStr };
            } else {
              try {
                var parsed = JSON.parse(contentStr);
                response = (typeof parsed === 'object' && parsed !== null) ? parsed : { result: contentStr };
              } catch(e) {
                response = { result: contentStr };
              }
            }
            parts.push({ functionResponse: { name: name, response: response } });
          }
        }
      }

      if (parts.length === 0) continue;

      // Merge consecutive same-role messages (Gemini requires strict alternation)
      var last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts = last.parts.concat(parts);
      } else {
        contents.push({ role: role, parts: parts });
      }
    }

    var body = { contents: contents };

    if (agentConfig.systemPrompt) {
      body.system_instruction = { parts: [{ text: agentConfig.systemPrompt }] };
    }

    body.generationConfig = {
      maxOutputTokens: agentConfig.maxTokens || 8192
    };

    if (tools && tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(function(t) {
          return {
            name: t.name,
            description: t.description,
            parameters: convertSchemaForGemini(t.input_schema)
          };
        })
      }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    return body;
  }

  // ===== 5. Streaming =====

  // ---- Streaming API request ----
  // Returns an object with an async iterator that yields SSE chunks
  function sendApiRequest(payload, endpoint) {
    var id = generateId();
    var handler = {
      chunks: [],
      done: false,
      error: null,
      notify: null
    };
    streamHandlers[id] = handler;
    self.postMessage({ type: 'api_request', id: id, payload: payload, endpoint: endpoint || undefined });

    return {
      [Symbol.asyncIterator]: function() {
        return {
          next: function() {
            return new Promise(function(resolve, reject) {
              function check() {
                if (handler.chunks.length > 0) {
                  resolve({ value: handler.chunks.shift(), done: false });
                } else if (handler.error) {
                  delete streamHandlers[id];
                  reject(new Error(handler.error));
                } else if (handler.done) {
                  delete streamHandlers[id];
                  resolve({ value: undefined, done: true });
                } else {
                  handler.notify = check;
                }
              }
              check();
            });
          }
        };
      }
    };
  }

  // ===== 6. Tool Dispatch =====

  // ---- Tool execution via postMessage ----
  function executeToolCall(name, input) {
    return new Promise(function(resolve, reject) {
      var id = generateId();

      if (name === 'runjs') {
        var code = input.code || '';
        var ctx = input.context || 'iframe';

        if (ctx === 'iframe') {
          setPendingWithTimeout(id, { resolve: function(data) {
            if (data && data.error) {
              resolve({ content: 'Error: ' + data.error, is_error: true });
            } else {
              resolve({ content: String((data && data.result) || 'undefined') });
            }
          }, reject: reject }, 60000, 'runjs');
          self.postMessage({ type: 'runjs_iframe', id: id, code: code });
          return;
        }

        // Worker context execution
        var consoleOutput = [];
        var mockConsole = {
          log: function() { consoleOutput.push(Array.prototype.slice.call(arguments).join(' ')); },
          error: function() { consoleOutput.push('[error] ' + Array.prototype.slice.call(arguments).join(' ')); },
          warn: function() { consoleOutput.push('[warn] ' + Array.prototype.slice.call(arguments).join(' ')); },
        };
        try {
          var fn = new Function('console', '"use strict";\n' + code);
          var result = fn(mockConsole);
          var parts = [];
          if (consoleOutput.length > 0) parts.push('Console:\n' + consoleOutput.join('\n'));
          parts.push('Result: ' + (result !== undefined ? String(result) : 'undefined'));
          resolve({ content: parts.join('\n\n') });
        } catch(err) {
          resolve({ content: 'Error: ' + err.message, is_error: true });
        }
        return;
      }

      if (name === 'dom') {
        var action = input.action;

        // Handle event listener actions
        if (action === 'listen') {
          setPendingWithTimeout(id, { resolve: function(data) {
            if (data && !data.success) {
              resolve({ content: 'Listen error: ' + (data.error || 'Unknown error'), is_error: true });
            } else {
              resolve({ content: 'Event listener registered for ' + input.selector + ' on events: ' + (input.events || []).join(', ') });
            }
          }, reject: reject }, 60000, 'DOM listen');
          self.postMessage({ type: 'dom_listen', id: id, selector: input.selector, events: input.events || [], options: input.options });
          return;
        }

        if (action === 'unlisten') {
          setPendingWithTimeout(id, { resolve: function(data) {
            if (data && !data.success) {
              resolve({ content: 'Unlisten error: ' + (data.error || 'Unknown error'), is_error: true });
            } else {
              resolve({ content: 'Event listener removed for ' + input.selector });
            }
          }, reject: reject }, 60000, 'DOM unlisten');
          self.postMessage({ type: 'dom_unlisten', id: id, selector: input.selector });
          return;
        }

        if (action === 'wait_for') {
          pendingResponses[id] = { resolve: function(data) {
            if (data && data.error) {
              resolve({ content: 'Wait error: ' + data.error, is_error: true });
            } else if (data && data.event) {
              var e = data.event;
              var result = 'Event received: ' + e.type + ' on ' + e.selector;
              if (e.target.id) result += ' (id: ' + e.target.id + ')';
              if (e.target.value !== undefined) result += ' [value: ' + e.target.value + ']';
              if (e.formData) result += '\\nForm data: ' + JSON.stringify(e.formData);
              resolve({ content: result });
            } else {
              resolve({ content: 'Event received' });
            }
          }, reject: reject };
          self.postMessage({ type: 'dom_wait', id: id, selector: input.selector, event: input.event, timeout: input.timeout });
          return;
        }

        if (action === 'get_listeners') {
          setPendingWithTimeout(id, { resolve: function(data) {
            if (data && data.listeners) {
              if (data.listeners.length === 0) {
                resolve({ content: 'No event listeners registered' });
              } else {
                var lines = data.listeners.map(function(l) {
                  return '- ' + l.selector + ' (' + l.events.join(', ') + ') -> worker: ' + l.workerId;
                });
                resolve({ content: 'Registered listeners:\\n' + lines.join('\\n') });
              }
            } else {
              resolve({ content: 'No event listeners registered' });
            }
          }, reject: reject }, 60000, 'DOM get_listeners');
          self.postMessage({ type: 'dom_get_listeners', id: id });
          return;
        }

        // Standard DOM actions
        setPendingWithTimeout(id, { resolve: function(data) {
          if (data && data.error) {
            resolve({ content: 'DOM error: ' + data.error, is_error: true });
          } else {
            var r = (data && data.result) || { description: 'Done', elementCount: 0 };
            var content = r.description + ' (' + r.elementCount + ' element(s))';
            if (r.rendered) {
              content += '\\nRendered: ' + r.rendered.width + 'x' + r.rendered.height;
              content += r.rendered.visible ? ', visible' : ' [NOT VISIBLE]';
              content += ', display: ' + r.rendered.display;
              content += ', ' + r.rendered.childCount + ' children';
            }
            resolve({ content: content });
          }
        }, reject: reject }, 60000, 'DOM');
        self.postMessage({ type: 'dom_command', id: id, command: {
          action: input.action,
          html: input.html,
          selector: input.selector,
          attributes: input.attributes,
          textContent: input.textContent,
          innerHTML: input.innerHTML,
          parentSelector: input.parentSelector,
        }});
        return;
      }

      if (name === 'fetch') {
        setPendingWithTimeout(id, { resolve: function(data) {
          if (data && (data.type === 'fetch_error' || data.error)) {
            resolve({ content: 'Fetch error: ' + (data.error || 'Unknown error'), is_error: true });
          } else {
            var parts = ['Status: ' + (data && data.status)];
            if (data && data.body) parts.push('Body:\n' + data.body);
            resolve({ content: parts.join('\n') });
          }
        }, reject: reject }, 60000, 'Fetch');
        self.postMessage({ type: 'fetch_request', id: id, url: input.url, options: {
          method: input.method || 'GET',
          headers: input.headers,
          body: input.body,
        }});
        return;
      }

      if (name === 'storage') {
        setPendingWithTimeout(id, { resolve: function(data) {
          if (data && data.error) {
            resolve({ content: 'Storage error: ' + data.error, is_error: true });
          } else if (input.action === 'list') {
            var keys = (data && data.result) || [];
            resolve({ content: Array.isArray(keys) && keys.length > 0 ? 'Keys: ' + keys.join(', ') : 'No keys found' });
          } else if (input.action === 'get') {
            resolve({ content: (data && data.result !== undefined && data.result !== null) ? String(data.result) : 'Key not found' });
          } else {
            resolve({ content: input.action === 'set' ? 'Value stored successfully' : 'Key deleted successfully' });
          }
        }, reject: reject }, 60000, 'Storage');
        self.postMessage({ type: 'storage_request', id: id, action: input.action, key: input.key, value: input.value });
        return;
      }

      if (name === 'files') {
        handleFilesTool(input).then(resolve).catch(function(err) {
          resolve({ content: 'Files error: ' + err.message, is_error: true });
        });
        return;
      }

      // Handle agent_respond tool for flo.ask() responses
      if (name === 'agent_respond') {
        if (pendingAskId) {
          self.postMessage({
            type: 'agent_ask_response',
            id: pendingAskId,
            result: input.result,
            error: input.error
          });
          pendingAskId = null;
          resolve({ content: 'Response sent to caller' });
        } else {
          resolve({ content: 'No pending ask to respond to', is_error: true });
        }
        return;
      }

      // Handle worker_message tool for inter-worker communication
      if (name === 'worker_message') {
        self.postMessage({
          type: 'worker_message',
          target: input.target || 'main',
          event: input.event,
          data: input.data
        });
        resolve({ content: 'Message sent to worker: ' + (input.target || 'main') });
        return;
      }

      // Handle view_state tool for changing the view layout
      if (name === 'view_state') {
        var state = input.state;
        var validStates = ['max', 'ui-only', 'chat-only'];
        if (validStates.indexOf(state) === -1) {
          resolve({ content: 'Invalid view state. Must be one of: ' + validStates.join(', '), is_error: true });
          return;
        }
        // Check if on mobile (max not available)
        if (state === 'max' && isMobile) {
          resolve({ content: 'Cannot use "max" view state on mobile. Use "ui-only" or "chat-only" instead.', is_error: true });
          return;
        }
        setPendingWithTimeout(id, { resolve: function(data) {
          if (data && data.error) {
            resolve({ content: 'View state error: ' + data.error, is_error: true });
          } else {
            resolve({ content: 'View state changed to: ' + state });
          }
        }, reject: reject }, 60000, 'View state');
        self.postMessage({ type: 'view_state_request', id: id, state: state });
        return;
      }

      if (name === 'capabilities') {
        setPendingWithTimeout(id, { resolve: function(data) {
          if (data && data.error) {
            resolve({ content: 'Capabilities error: ' + data.error, is_error: true });
          } else {
            resolve({ content: JSON.stringify(data.result, null, 2) });
          }
        }, reject: reject }, 60000, 'Capabilities');
        var capMsg = { type: 'capabilities_request', id: id, action: input.probe ? 'probe' : 'snapshot' };
        if (input.probe) { capMsg.probe = input.probe; }
        if (input.url || input.name) {
          capMsg.probeArgs = {};
          if (input.url) capMsg.probeArgs.url = input.url;
          if (input.name) capMsg.probeArgs.name = input.name;
        }
        self.postMessage(capMsg);
        return;
      }

      if (name === 'state') {
        setPendingWithTimeout(id, { resolve: function(data) {
          if (data && data.error) {
            resolve({ content: 'State error: ' + data.error, is_error: true });
          } else {
            var action = input.action;
            if (action === 'get') {
              resolve({ content: data.result !== undefined ? JSON.stringify(data.result) : 'Key not found' });
            } else if (action === 'get_all') {
              resolve({ content: JSON.stringify(data.result) });
            } else if (action === 'set') {
              resolve({ content: 'State updated' });
            } else if (action === 'delete') {
              resolve({ content: 'State key deleted' });
            } else if (action === 'escalation_rules') {
              resolve({ content: JSON.stringify(data.result) });
            } else if (action === 'escalate') {
              resolve({ content: 'Escalation rule set' });
            } else if (action === 'clear_escalation') {
              resolve({ content: 'Escalation rule cleared' });
            } else {
              resolve({ content: JSON.stringify(data.result) });
            }
          }
        }, reject: reject }, 60000, 'State');
        self.postMessage({ type: 'state_request', id: id, action: input.action, key: input.key, value: input.value, condition: input.condition, message: input.message });
        return;
      }

      // Generic fallback: delegate unknown tools to shell via plugin registry
      setPendingWithTimeout(id, { resolve: function(data) {
        if (data && data.error) {
          resolve({ content: 'Tool error: ' + data.error, is_error: true });
        } else {
          resolve({ content: String((data && data.result) || 'Tool executed') });
        }
      }, reject: reject }, 60000, 'Tool');
      self.postMessage({ type: 'tool_execute', id: id, name: name, input: input });
    });
  }

  // ---- Files Tool (via postMessage to shell) ----
  function validateFilePath(path) {
    if (!path || typeof path !== 'string') {
      throw new Error('Path is required and must be a string');
    }
    if (path.indexOf('\0') !== -1) {
      throw new Error('Path must not contain null bytes');
    }
    if (path.length > 512) {
      throw new Error('Path must not exceed 512 characters');
    }
    var segments = path.split('/').filter(function(s) { return s.length > 0; });
    if (segments.length === 0) {
      throw new Error('Path must have at least one segment');
    }
    return segments;
  }

  function handleFilesTool(input) {
    var action = input.action;
    var path = input.path || '';

    // For directory operations, allow root path references
    var isRootPath = (path === '.' || path === '/' || path === './' || path === '' || path === 'root');
    var isDirOp = (action === 'list_dir' || action === 'list_files' || action === 'mkdir');
    var isGlobOp = (action === 'frontmatter');

    if (isGlobOp) {
      path = input.pattern || '*';
    } else if (!isDirOp || !isRootPath) {
      validateFilePath(path);
    }

    return new Promise(function(resolve, reject) {
      var id = generateId();
      setPendingWithTimeout(id, {
        resolve: function(data) {
          if (data && data.error) {
            resolve({ content: 'Files error: ' + data.error, is_error: true });
          } else {
            resolve({ content: String(data && data.result || '') });
          }
        },
        reject: reject
      }, 60000, 'Files');
      self.postMessage({
        type: 'file_request',
        id: id,
        action: action,
        path: isRootPath && isDirOp ? '.' : path,
        content: input.content
      });
    });
  }

  // ===== 7. Hook System =====
  function checkHook(hookType, payload) {
    if (activeHookTypes.indexOf(hookType) === -1) {
      return Promise.resolve({ decision: 'default' });
    }
    return new Promise(function(resolve) {
      var id = generateId();
      setPendingWithTimeout(id, { resolve: resolve, reject: function() { resolve({ decision: 'default' }); } }, 10000, 'Hook');
      var msg = { type: hookType, id: id };
      // Copy payload fields into msg
      var keys = Object.keys(payload);
      for (var i = 0; i < keys.length; i++) {
        msg[keys[i]] = payload[keys[i]];
      }
      self.postMessage(msg);
    });
  }

  // ===== 8. Agentic Loop =====
  async function runAgenticLoop(agentConfig, initialMessage) {
    if (loopRunning) return;
    loopRunning = true;
    stopped = false;
    turnMessages = [];

    // Check agent_start hook
    var startResult = await checkHook('agent_start', {});
    if (startResult.decision === 'deny') {
      emitEvent({ type: 'error', error: 'Agent start denied' + (startResult.reason ? ': ' + startResult.reason : '') });
      loopRunning = false;
      return;
    }

    var tools = (agentConfig.tools || []).map(function(t) {
      return { name: t.name, description: t.description, input_schema: t.input_schema };
    });

    turnMessages.push({ role: 'user', content: [{ type: 'text', text: initialMessage }] });

    var running = true;
    var MAX_ITERATIONS = 200;
    var iterationCount = 0;
    var cumulativeInputTokens = 0;
    var cumulativeOutputTokens = 0;

    try {
    while (running) {
      // Check iteration limit
      iterationCount++;
      if (iterationCount > MAX_ITERATIONS) {
        emitEvent({ type: 'budget_exceeded', reason: 'iteration_limit', message: 'Exceeded maximum iterations (' + MAX_ITERATIONS + ')' });
        return;
      }

      if (paused && !stopped) {
        await new Promise(function(r) { setTimeout(r, 100); });
        continue;
      }
      if (stopped) {
        running = false;
        break;
      }

      var provider = agentConfig.provider || 'anthropic';
      var mapper;
      if (provider === 'anthropic') {
        mapper = createEventMapper();
      } else if (provider === 'gemini') {
        mapper = createGeminiEventMapper();
      } else {
        mapper = createOpenAIEventMapper();
      }
      var parser = createSSEParser();

      // Build API request body
      var body;
      if (provider === 'anthropic') {
        body = {
          model: agentConfig.model,
          max_tokens: agentConfig.maxTokens || 4096,
          messages: turnMessages.map(function(m) {
            return {
              role: m.role,
              content: m.content.map(function(c) {
                if (c.type === 'text') return { type: 'text', text: c.text };
                if (c.type === 'tool_use') return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
                if (c.type === 'tool_result') return {
                  type: 'tool_result',
                  tool_use_id: c.tool_use_id,
                  content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
                  is_error: c.is_error || undefined,
                };
                return c;
              })
            };
          }),
          stream: true
        };
        if (agentConfig.systemPrompt) body.system = agentConfig.systemPrompt;
        if (tools.length > 0) body.tools = tools;
      } else if (provider === 'gemini') {
        body = buildGeminiRequestBody(agentConfig, turnMessages, tools);
      } else {
        body = buildOpenAIRequestBody(agentConfig, turnMessages, tools);
      }

      var assistantContent = [];
      var toolCalls = [];
      var stopReason = 'end_turn';

      try {
        var endpoint;
        if (provider === 'gemini') {
          endpoint = '/api/gemini/v1beta/models/' + agentConfig.model + ':streamGenerateContent?alt=sse';
        }
        var stream = sendApiRequest(body, endpoint);
        for await (var chunk of stream) {
          // Mid-stream pause check
          while (paused && !stopped) {
            await new Promise(function(r) { setTimeout(r, 50); });
          }
          if (stopped) break;
          var sseEvents = parser.feed(chunk);
          for (var i = 0; i < sseEvents.length; i++) {
            var agentEvents = mapper.mapSSEEvent(sseEvents[i]);
            for (var j = 0; j < agentEvents.length; j++) {
              var event = agentEvents[j];
              emitEvent(event);

              if (event.type === 'usage') {
                cumulativeInputTokens += (event.usage.input_tokens || 0);
                cumulativeOutputTokens += (event.usage.output_tokens || 0);
                // Check token budget
                if (agentConfig.tokenBudget && (cumulativeInputTokens + cumulativeOutputTokens) > agentConfig.tokenBudget) {
                  emitEvent({ type: 'budget_exceeded', reason: 'token_limit', message: 'Token budget exceeded' });
                  return;
                }
              }

              if (event.type === 'text_done') {
                assistantContent.push({ type: 'text', text: event.text });
              } else if (event.type === 'tool_use_done') {
                var toolUse = { type: 'tool_use', id: event.toolUseId, name: event.toolName, input: event.input };
                if (event.truncated) toolUse._truncated = true;
                if (event.thoughtSignature) toolUse.thoughtSignature = event.thoughtSignature;
                assistantContent.push(toolUse);
                toolCalls.push(toolUse);
              } else if (event.type === 'turn_end') {
                stopReason = event.stopReason;
              }
            }
          }
        }
      } catch(err) {
        emitEvent({ type: 'error', error: String(err) });
        return;
      }

      // Fallback: detect tool calls output as text (some models like Gemini 3 previews
      // output tool calls as text instead of structured functionCall parts).
      if (toolCalls.length === 0 && assistantContent.length > 0) {
        var toolNames = tools.map(function(t) { return t.name; });
        var textToolCalls = parseTextToolCalls(assistantContent, toolNames);
        if (textToolCalls.length > 0) {
          // Remove text blocks that contained tool calls — keeping them causes the model
          // to see both the raw text AND the structured functionCall in history, which
          // confuses models like Gemini 3 into calling the tool again endlessly.
          var parsedNames = {};
          for (var ti2 = 0; ti2 < textToolCalls.length; ti2++) {
            parsedNames[textToolCalls[ti2].name] = true;
          }
          assistantContent = assistantContent.filter(function(block) {
            if (block.type !== 'text') return true;
            var text = block.text.trim();
            for (var tn = 0; tn < toolNames.length; tn++) {
              if (parsedNames[toolNames[tn]] && text.indexOf(toolNames[tn] + '\n') >= 0) {
                return false;  // Remove this text block — it was a text-based tool call
              }
            }
            return true;
          });
          for (var ti3 = 0; ti3 < textToolCalls.length; ti3++) {
            assistantContent.push(textToolCalls[ti3]);
            toolCalls.push(textToolCalls[ti3]);
            // Emit events so UI shows the tool call
            emitEvent({ type: 'tool_use_start', toolUseId: textToolCalls[ti3].id, toolName: textToolCalls[ti3].name });
            emitEvent({ type: 'tool_use_input_delta', toolUseId: textToolCalls[ti3].id, partialJson: JSON.stringify(textToolCalls[ti3].input) });
            emitEvent({ type: 'tool_use_done', toolUseId: textToolCalls[ti3].id, toolName: textToolCalls[ti3].name, input: textToolCalls[ti3].input });
          }
          stopReason = 'tool_use';
        }
      }

      if (assistantContent.length > 0) {
        turnMessages.push({ role: 'assistant', content: assistantContent });
      }

      // Handle max_tokens with pending tool calls — treat them as truncated
      if (stopReason === 'max_tokens' && toolCalls.length > 0) {
        stopReason = 'tool_use';
        for (var ti = 0; ti < toolCalls.length; ti++) {
          if (!toolCalls[ti]._truncated) continue;
          toolCalls[ti]._truncated = true;
        }
      }

      if (stopReason === 'tool_use' && toolCalls.length > 0) {
        var toolResults = [];
        for (var k = 0; k < toolCalls.length; k++) {
          var tc = toolCalls[k];
          // Handle truncated tool calls (max_tokens cut off the response)
          if (tc._truncated) {
            var truncResult = { content: 'Tool call was truncated by max_tokens limit. The response was too large. Try breaking it into smaller tool calls.', is_error: true };
            emitEvent({ type: 'tool_result', toolUseId: tc.id, result: truncResult });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: truncResult.content,
              is_error: true,
            });
            continue;
          }
          // Pre-tool-use hook
          var preResult = await checkHook('pre_tool_use', { toolName: tc.name, toolInput: tc.input });
          if (preResult.decision === 'deny') {
            var deniedResult = { content: 'Tool use denied' + (preResult.reason ? ': ' + preResult.reason : ''), is_error: true };
            emitEvent({ type: 'tool_result', toolUseId: tc.id, result: deniedResult });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: deniedResult.content,
              is_error: true,
            });
            continue;
          }
          var toolInput = (preResult.modifiedInput) ? preResult.modifiedInput : tc.input;
          try {
            var result = await executeToolCall(tc.name, toolInput);
            // Post-tool-use hook
            await checkHook('post_tool_use', { toolName: tc.name, toolInput: toolInput, toolResult: result });
            emitEvent({ type: 'tool_result', toolUseId: tc.id, result: result });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
              is_error: result.is_error,
            });
          } catch(err) {
            var errResult = { content: String(err), is_error: true };
            emitEvent({ type: 'tool_result', toolUseId: tc.id, result: errResult });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: String(err),
              is_error: true,
            });
          }
        }
        turnMessages.push({ role: 'user', content: toolResults });
        if (stopped) { running = false; break; }
      } else {
        // Check stop hook
        var stopResult = await checkHook('stop', { stopReason: stopReason });
        if (stopResult.decision === 'deny') {
          // Continue looping with the reason as a user message
          var continueMsg = stopResult.reason || 'Please continue.';
          turnMessages.push({ role: 'user', content: [{ type: 'text', text: continueMsg }] });
        } else {
          // Check agent_end hook before stopping
          var endResult = await checkHook('agent_end', {});
          if (endResult.decision === 'deny' && endResult.reason) {
            // Continue looping with the reason as a user message
            turnMessages.push({ role: 'user', content: [{ type: 'text', text: endResult.reason }] });
          } else {
            running = false;
          }
        }
      }
    }
    } finally {
      loopRunning = false;
      // Signal that the agentic loop iteration completed
      emitEvent({ type: 'loop_complete' });
      // Process any queued events
      if (eventQueue.length > 0 && !paused && !stopped) {
        var nextEvent = eventQueue.shift();
        setTimeout(function() {
          if (config && !paused && !stopped) {
            runAgenticLoop(config, nextEvent).catch(function(err) {
              emitEvent({ type: 'error', error: 'Loop error: ' + String(err) });
            });
          }
        }, 0);
      }
    }
  }

  // Format DOM event as a user message
  function formatDomEventAsMessage(event) {
    var msg = 'User ' + event.type + ' on ' + event.selector;
    if (event.target.id) msg += ' (#' + event.target.id + ')';
    if (event.target.value !== undefined) msg += ' [value: ' + event.target.value + ']';
    if (event.formData) msg += '\nForm data: ' + JSON.stringify(event.formData);
    return msg;
  }

  // Queue content for the next loop iteration, or start a new loop if idle
  function queueOrRunLoop(content) {
    if (loopRunning) {
      if (eventQueue.length < MAX_EVENT_QUEUE_SIZE) {
        eventQueue.push(content);
      }
    } else if (!paused && config) {
      runAgenticLoop(config, content).catch(function(err) {
        emitEvent({ type: 'error', error: 'Loop error: ' + String(err) });
      });
    }
  }

  // Set a pending response with an optional timeout (ms). If timeout fires, resolves with an error.
  function setPendingWithTimeout(id, resolveObj, timeoutMs, toolName) {
    var timer = null;
    if (timeoutMs) {
      timer = setTimeout(function() {
        var pr = pendingResponses[id];
        if (pr) {
          delete pendingResponses[id];
          pr.resolve({ error: (toolName || 'Tool') + ' timed out after ' + (timeoutMs / 1000) + 's' });
        }
      }, timeoutMs);
    }
    resolveObj._timer = timer;
    pendingResponses[id] = resolveObj;
  }

  // Resolve a pending response by id: delete from map and call resolve
  function resolvePending(id, data) {
    var pr = pendingResponses[id];
    if (pr) {
      if (pr._timer) clearTimeout(pr._timer);
      delete pendingResponses[id];
      pr.resolve(data);
    }
  }

  // ===== 9. Message Handler =====
  self.addEventListener('message', function(e) {
    var data = e.data;
    if (!data) return;

    switch (data.type) {
      case 'start':
        config = data.config;
        emitEvent({ type: 'state_change', from: 'pending', to: 'running' });
        if (data.userMessage) {
          runAgenticLoop(config, data.userMessage).catch(function(err) {
            emitEvent({ type: 'error', error: 'Loop error: ' + String(err) });
          });
        }
        break;

      case 'user_message':
        if (!loopRunning && config) {
          (async function() {
            var promptToUse = data.content;
            var hookResult = await checkHook('user_prompt_submit', { prompt: data.content });
            if (hookResult.decision === 'deny') {
              emitEvent({ type: 'error', error: 'User prompt denied' + (hookResult.reason ? ': ' + hookResult.reason : '') });
              return;
            }
            if (hookResult.modifiedPrompt) {
              promptToUse = hookResult.modifiedPrompt;
            }
            if (!paused) {
              runAgenticLoop(config, promptToUse).catch(function(err) {
                emitEvent({ type: 'error', error: 'Loop error: ' + String(err) });
              });
            }
          })();
        } else if (loopRunning) {
          if (eventQueue.length < MAX_EVENT_QUEUE_SIZE) {
            eventQueue.push(data.content);
          }
        }
        break;

      case 'pause':
        paused = true;
        break;

      case 'resume':
        paused = false;
        break;

      case 'stop_agent':
        stopped = true;
        paused = false;  // Break out of any pause wait
        break;

      case 'config_update':
        if (config && data.config) {
          if (data.config.model !== undefined) config.model = data.config.model;
          if (data.config.systemPrompt !== undefined) config.systemPrompt = data.config.systemPrompt;
          if (data.config.maxTokens !== undefined) config.maxTokens = data.config.maxTokens;
          if (data.config.tokenBudget !== undefined) config.tokenBudget = data.config.tokenBudget;
          if (data.config.costBudgetUsd !== undefined) config.costBudgetUsd = data.config.costBudgetUsd;
          if (data.config.provider !== undefined) config.provider = data.config.provider;
        }
        break;

      // Streaming API response chunks
      case 'api_response_chunk':
        var sh = streamHandlers[data.id];
        if (sh) {
          sh.chunks.push(data.chunk);
          if (sh.notify) { var n = sh.notify; sh.notify = null; n(); }
        }
        break;

      case 'api_response_end':
        var sh2 = streamHandlers[data.id];
        if (sh2) {
          sh2.done = true;
          if (sh2.notify) { var n2 = sh2.notify; sh2.notify = null; n2(); }
        }
        break;

      case 'api_response_error':
        var sh3 = streamHandlers[data.id];
        if (sh3) {
          sh3.error = data.error || 'API request failed';
          sh3.done = true;
          if (sh3.notify) { var n3 = sh3.notify; sh3.notify = null; n3(); }
        }
        break;

      // View state response (has side effect: updates viewState)
      case 'view_state_response':
        if (data.success) {
          viewState = data.state;
        }
        resolvePending(data.id, data);
        break;

      // Hook system messages
      case 'hooks_config':
        activeHookTypes = data.activeHookTypes || [];
        break;

      // Visibility change from shell
      case 'visibility_change':
        visible = data.visible;
        emitEvent({ type: 'visibility_change', visible: visible });
        break;

      // View state change from shell
      case 'set_view_state':
        viewState = data.state;
        emitEvent({ type: 'view_state_change', from: viewState, to: data.state, requestedBy: 'user' });
        break;

      case 'set_hub_mode':
        hubMode = data.enabled;
        break;

      // Mobile state change from shell
      case 'set_mobile':
        isMobile = data.isMobile;
        break;

      // Pending response resolution — hooks, tool results, and non-streaming responses
      case 'state_result':
      case 'capabilities_result':
      case 'pre_tool_use_result':
      case 'post_tool_use_result':
      case 'agent_stop_result':
      case 'user_prompt_submit_result':
      case 'agent_start_result':
      case 'agent_end_result':
      case 'tool_execute_result':
      case 'dom_result':
      case 'runjs_result':
      case 'storage_result':
      case 'file_result':
      case 'fetch_response':
      case 'fetch_error':
      case 'dom_wait_result':
      case 'dom_listen_result':
      case 'dom_listeners_result':
        resolvePending(data.id, data);
        break;

      // DOM event system
      case 'viewport_update':
        // Update internal state only — don't wake the agent for every resize.
        // Agents that need viewport changes should use dom listen on window resize
        // or flo.state.escalate with a page-JS resize handler.
        break;

      case 'dom_event': {
        var domMsg = formatDomEventAsMessage(data.event);
        if (hubMode) {
          self.postMessage({ type: 'hub_page_event', content: domMsg });
        } else {
          emitEvent({ type: 'page_event_message', content: domMsg });
          queueOrRunLoop(domMsg);
        }
        break;
      }

      // JS -> Agent calls (flo API)
      case 'agent_notify': {
        var notifyMsg = 'Event: ' + data.event + '\nData: ' + JSON.stringify(data.data) +
          (data.viewState === 'ui-only' ? '\n(User is in ui-only view — they cannot see chat)' : '');
        if (hubMode) {
          self.postMessage({ type: 'hub_page_event', content: notifyMsg });
        } else {
          emitEvent({ type: 'page_event_message', content: notifyMsg });
          queueOrRunLoop(notifyMsg);
        }
        break;
      }

      case 'agent_ask': {
        pendingAskId = data.id;  // Track so agent_respond tool knows where to send
        var askMsg = 'Request: ' + data.event + '\nData: ' + JSON.stringify(data.data) +
          (data.viewState === 'ui-only' ? '\n(User is in ui-only view — they cannot see chat)' : '') +
          '\n\nRespond with agent_respond({ result: ... }) to send data back to the caller.';
        if (hubMode) {
          self.postMessage({ type: 'hub_page_event', content: askMsg });
        } else {
          emitEvent({ type: 'page_event_message', content: askMsg });
          queueOrRunLoop(askMsg);
        }
        break;
      }

      // Inter-worker messaging
      case 'worker_event': {
        var workerMsg = 'Message from ' + data.from + ': ' + data.event +
                       '\nData: ' + JSON.stringify(data.data);
        if (hubMode) {
          self.postMessage({ type: 'hub_page_event', content: workerMsg });
        } else {
          emitEvent({ type: 'page_event_message', content: workerMsg });
          queueOrRunLoop(workerMsg);
        }
        break;
      }

      // Runtime errors from agent's DOM code (onclick handlers, etc.)
      case 'runtime_error':
        // Handle batch format (data.errors array) with backward compat
        var errors = data.errors || (data.error ? [data.error] : []);
        if (errors.length === 0) break;
        var errLines = 'Runtime errors in your page:\n';
        for (var ei = 0; ei < errors.length; ei++) {
          var errInfo = errors[ei];
          var cat = errInfo.category ? '[' + errInfo.category + '] ' : '';
          var countStr = errInfo.count > 1 ? ' x' + errInfo.count : '';
          errLines += (ei + 1) + '. ' + cat + (errInfo.message || 'Unknown error');
          if (errInfo.line) errLines += ' (line ' + errInfo.line + ')';
          errLines += countStr + '\n';
        }
        errLines += '\nFix these errors in your code. Remember: use var (not const/let) for top-level variables to avoid redeclaration errors.';
        if (hubMode) {
          self.postMessage({ type: 'hub_page_event', content: errLines });
        } else {
          emitEvent({ type: 'page_event_message', content: errLines });
          queueOrRunLoop(errLines);
        }
        break;

      // Shell requesting tool execution (for hook scripts)
      case 'shell_tool_request':
        (async function() {
          try {
            var result = await executeToolCall(data.name, data.input);
            self.postMessage({
              type: 'shell_tool_response',
              id: data.id,
              result: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
              error: result.is_error ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content)) : undefined
            });
          } catch (err) {
            self.postMessage({
              type: 'shell_tool_response',
              id: data.id,
              error: String(err)
            });
          }
        })();
        break;

      // Shell requesting script execution (for hook scripts in sandboxed context)
      case 'shell_script_request':
        (async function() {
          try {
            // Build context with hook data + callTool API
            var context = data.context || {};
            context.callTool = async function(name, input) {
              return executeToolCall(name, input);
            };
            context.log = function() {
              var args = Array.prototype.slice.call(arguments);
              console.log.apply(console, ['[hook:script]'].concat(args));
            };

            // Create and execute async function
            var keys = Object.keys(context);
            var values = keys.map(function(k) { return context[k]; });
            var AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            var fn = new AsyncFunction.apply(null, keys.concat([data.code]));
            var result = await fn.apply(null, values);

            self.postMessage({
              type: 'shell_script_response',
              id: data.id,
              result: result
            });
          } catch (err) {
            self.postMessage({
              type: 'shell_script_response',
              id: data.id,
              error: err.message
            });
          }
        })();
        break;
    }
  });
})();
