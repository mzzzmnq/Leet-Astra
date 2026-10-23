"""Small, bounded Python tracer used inside the disposable Pyodide worker."""
import ast
import contextlib
import inspect
import io
import itertools
import sys
import time
import tokenize
import typing


class ListNode:
    def __init__(self, val=0, next=None):
        self.val, self.next = val, next


class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right


class _Limit(BaseException):
    pass


def _snapshot(value, depth=0, seen=None):
    """Avoid user-defined repr/iteration/property hooks in debugger snapshots."""
    seen = set() if seen is None else seen
    kind = type(value)
    if kind in (type(None), bool, int, float, str):
        if kind is int and value.bit_length() > 1000:
            return '<large int>'
        return repr(value[:200] + ('…' if len(value) > 200 else '')) if kind is str else repr(value)
    if id(value) in seen:
        return '<cycle>'
    if depth >= 3:
        return '…'
    seen = seen | {id(value)}
    render = lambda item: _snapshot(item, depth + 1, seen)
    if kind in (list, tuple):
        left, right = ('[', ']') if kind is list else ('(', ')')
        return left + ', '.join(render(item) for item in value[:20]) + (', …' if len(value) > 20 else '') + right
    if kind is dict:
        items = list(itertools.islice(value.items(), 20))
        return '{' + ', '.join(render(k) + ': ' + render(v) for k, v in items) + (', …' if len(value) > 20 else '') + '}'
    if kind in (ListNode, TreeNode):
        fields = ('val', 'next') if kind is ListNode else ('val', 'left', 'right')
        data = object.__getattribute__(value, '__dict__')
        return kind.__name__ + '(' + ', '.join(key + '=' + render(data.get(key)) for key in fields) + ')'
    return '<' + kind.__name__ + '>'


def _inputs(text):
    if not text.strip():
        return [], {}

    class Constants(ast.NodeTransformer):
        def visit_Name(self, node):
            if node.id in ('true', 'false', 'null'):
                return ast.copy_location(ast.Constant({'true': True, 'false': False, 'null': None}[node.id]), node)
            return node

    def literal(node):
        return ast.literal_eval(Constants().visit(node))

    # NEWLINE ends a logical argument row; NL keeps bracketed values together.
    rows, tokens = [], []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type in (tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER):
            continue
        if token.type == tokenize.NEWLINE:
            rows.append(tokenize.untokenize(tokens).strip())
            tokens = []
        elif token.type != tokenize.COMMENT:
            tokens.append((token.type, token.string))
    if tokens:
        rows.append(tokenize.untokenize(tokens).strip())
    args, kwargs = [], {}
    for row in rows:
        if not row:
            continue
        call = ast.parse('_input(' + row + ')', mode='eval').body
        for node in call.args:
            args.append(literal(node))
        for item in call.keywords:
            if item.arg is None or item.arg in kwargs:
                raise ValueError('Input names must be unique; ** expansion is unsupported')
            kwargs[item.arg] = literal(item.value)
    return args, kwargs


def _convert(value, parameter):
    annotation = parameter.annotation
    name = annotation if isinstance(annotation, str) else str(annotation)
    if type(value) is not list:
        return value
    if 'ListNode' in name:
        head = None
        for item in reversed(value):
            head = ListNode(item, head)
        return head
    if 'TreeNode' in name:
        if not value or value[0] is None:
            return None
        root = TreeNode(value[0])
        queue, index = [root], 1
        for parent in queue:
            for field in ('left', 'right'):
                if index >= len(value):
                    return root
                item = value[index]
                index += 1
                if item is not None:
                    child = TreeNode(item)
                    setattr(parent, field, child)
                    queue.append(child)
        if index < len(value):
            raise ValueError('Tree input has unreachable nodes')
        return root
    return value



def _compare_result(actual, expected_text):
    """Compare complete builtin values, independently of display snapshots."""
    class Skip(Exception):
        pass

    class Constants(ast.NodeTransformer):
        def visit_Name(self, node):
            values = {'true': True, 'false': False, 'null': None}
            return ast.copy_location(ast.Constant(values[node.id]), node) if node.id in values else node

    if len(expected_text) > 100000:
        return {'status': 'error', 'message': '预期结果超过 100000 字符限制'}
    try:
        expected = ast.literal_eval(Constants().visit(ast.parse(expected_text.strip(), mode='eval')))
    except (ValueError, SyntaxError, TypeError, RecursionError) as error:
        return {'status': 'error', 'message': '预期结果格式无效：请填写 Python 或 JSON 字面量（' + type(error).__name__ + '）'}
    budget = 10000
    has_float = False

    def validate(value, path, ancestors=frozenset(), depth=0):
        nonlocal budget, has_float
        budget -= 1
        if budget < 0 or depth > 64:
            raise Skip('比较超过 10000 个值或 64 层深度限制')
        kind = type(value)
        if kind not in (type(None), bool, int, float, str, list, tuple, dict):
            raise Skip(path + '：暂不支持此对象类型的比较')
        has_float = has_float or kind is float
        if kind in (list, tuple, dict):
            if id(value) in ancestors:
                raise Skip(path + '：循环引用无法比较')
            ancestors = ancestors | {id(value)}
            if kind is dict:
                for key, item in value.items():
                    validate(key, path + '[键]', ancestors, depth + 1)
                    validate(item, path + '[' + _snapshot(key)[:80] + ']', ancestors, depth + 1)
            else:
                for index, item in enumerate(value):
                    validate(item, path + '[' + str(index) + ']', ancestors, depth + 1)

    def key_identity(key):
        return (type(key).__name__, tuple(key_identity(v) for v in key) if type(key) is tuple else key)

    def difference(value, wanted, path='$'):
        if type(value) is not type(wanted):
            return path + '：类型不同，预期 ' + type(wanted).__name__ + '，实际 ' + type(value).__name__
        if type(value) in (list, tuple, dict):
            if len(value) != len(wanted):
                return path + '：长度不同，预期 ' + str(len(wanted)) + '，实际 ' + str(len(value))
            if type(value) is dict:
                actual_keys = {key_identity(key): key for key in value}
                for key, item in wanted.items():
                    location = path + '[' + _snapshot(key)[:80] + ']'
                    identity = key_identity(key)
                    if identity not in actual_keys:
                        return location + '：缺少预期键（键类型也须一致）'
                    mismatch = difference(value[actual_keys[identity]], item, location)
                    if mismatch:
                        return mismatch
            else:
                for index, (item, expected_item) in enumerate(zip(value, wanted)):
                    mismatch = difference(item, expected_item, path + '[' + str(index) + ']')
                    if mismatch:
                        return mismatch
        elif value != wanted:
            return path + '：值不同，预期 ' + _snapshot(wanted)[:200] + '，实际 ' + _snapshot(value)[:200]
        return ''

    try:
        validate(actual, '$')
        validate(expected, '$')
        mismatch = difference(actual, expected)
    except Skip as error:
        return {'status': 'skip', 'message': str(error)}
    suffix = '；浮点数按精确值比较，容差为 0' if has_float else ''
    return {'status': 'fail' if mismatch else 'pass', 'message': (mismatch or '实际返回值与预期结果一致') + suffix}


def trace_code(code: str, case_text: str, entry: str = '', expected_text: str = ''):
    events, frame_states, loops = [], {}, {}
    result = {'events': events, 'result': '', 'stdout': '', 'error': '', 'limited': False, 'entry': entry}
    result['comparison'] = {'status': 'skip', 'message': '未填写预期结果'}
    frame_ids, next_frame_id = {}, 0
    returned, actual = False, None
    started = time.monotonic()

    class Output(io.StringIO):
        def write(self, text):
            remaining = 4000 - self.tell()
            super().write(text[:max(0, remaining)])
            if len(text) > remaining:
                raise _Limit('Output limit (4000 characters) reached')
            return len(text)

    output = Output()

    class Instrument(ast.NodeTransformer):
        def __init__(self):
            self.parents = []
            self.owner = ('<module>', 1)

        def scope(self, node):
            previous = self.parents, self.owner
            self.parents = []
            self.owner = (node.name, min([node.lineno] + [item.lineno for item in node.decorator_list]))
            self.generic_visit(node)
            self.parents, self.owner = previous
            return node

        visit_FunctionDef = scope
        visit_AsyncFunctionDef = scope
        visit_ClassDef = scope

        def instrument(self, node):
            line = node.lineno
            loops[line] = (node.body[-1].end_lineno, tuple(self.parents), self.owner)
            self.parents.append(line)
            self.generic_visit(node)
            self.parents.pop()
            injected = ast.Expr(value=ast.Call(func=ast.Name(id='_openleet_tick', ctx=ast.Load()), args=[ast.Constant(line)], keywords=[]))
            for child in ast.walk(injected):
                child.lineno = child.end_lineno = 0
                child.col_offset = child.end_col_offset = 0
            node.body.insert(0, injected)
            return node

        visit_For = instrument
        visit_While = instrument

    def tick(line):
        frame = sys._getframe(1)
        state = frame_states.setdefault(id(frame), {})
        parents = loops[line][1]
        signature = tuple(state.get(parent, (None, 0))[1] for parent in parents)
        old_signature, count = state.get(line, (None, 0))
        state[line] = (signature, count + 1 if signature == old_signature else 1)
        for child, (_, ancestors, _) in loops.items():
            if line in ancestors:
                state.pop(child, None)

    def trace(frame, event, arg):
        nonlocal next_frame_id
        if frame.f_code.co_filename != '<openleet-user>':
            return trace
        if event == 'call':
            next_frame_id += 1
            frame_ids[id(frame)] = next_frame_id
        if time.monotonic() - started > 3:
            raise _Limit('Execution time limit (3 seconds) reached')
        if event not in ('line', 'return', 'exception') or frame.f_lineno == 0:
            return trace
        if len(events) >= 2000:
            raise _Limit('Trace limit (2000 events) reached')
        state = frame_states.setdefault(id(frame), {})
        depth, parent = 0, frame.f_back
        while parent:
            if parent.f_code.co_filename == '<openleet-user>':
                depth += 1
            parent = parent.f_back
        snapshot = {key: _snapshot(value) for key, value in itertools.islice(frame.f_locals.items(), 100)
                    if not key.startswith('__') and key not in namespace_base}
        # iteration counts bodies entered so far in this activation. A first
        # condition/iterator check is 0; body snapshots start at 1.
        active = [{'line': line, 'iteration': state.get(line, (None, 0))[1]}
                  for line, (end, _, owner) in loops.items() if line <= frame.f_lineno <= end
                  and owner == (frame.f_code.co_name, frame.f_code.co_firstlineno)]
        item = {'line': frame.f_lineno, 'event': 'before' if event == 'line' else event,
                'locals': snapshot, 'loops': active, 'function': frame.f_code.co_name, 'depth': depth, 'frameId': frame_ids[id(frame)]}
        if event == 'return':
            item['returnValue'] = _snapshot(arg)
            frame_states.pop(id(frame), None)
            frame_ids.pop(id(frame), None)
        elif event == 'exception':
            item['exception'] = arg[0].__name__ + ': ' + str(arg[1])[:500]
        events.append(item)
        return trace

    namespace_base = {name: getattr(typing, name) for name in typing.__all__}
    namespace_base.update({'ListNode': ListNode, 'TreeNode': TreeNode, '_openleet_tick': tick})
    namespace = dict(namespace_base)
    old_trace = sys.gettrace()
    try:
        args, kwargs = _inputs(case_text)
        tree = Instrument().visit(ast.parse(code, filename='<openleet-user>'))
        compiled = compile(ast.fix_missing_locations(tree), '<openleet-user>', 'exec')
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            sys.settrace(trace)
            exec(compiled, namespace)
            target = None
            solution = namespace.get('Solution')
            candidates = {}
            if inspect.isclass(solution):
                instance = solution()
                candidates.update({name: getattr(instance, name) for name, value in vars(solution).items()
                                   if not name.startswith('_') and inspect.isfunction(value)})
            else:
                candidates.update({name: value for name, value in namespace.items()
                                   if not name.startswith('_') and inspect.isfunction(value)
                                   and value.__code__.co_filename == '<openleet-user>'})
            selected = entry.removeprefix('Solution.')
            if selected:
                if selected not in candidates:
                    raise ValueError('Entry not found: ' + entry)
                target = candidates[selected]
            elif len(candidates) == 1:
                selected, target = next(iter(candidates.items()))
            elif candidates:
                raise ValueError('Choose an entry: ' + ', '.join(candidates))
            elif args or kwargs:
                raise ValueError('No callable entry found for the supplied inputs')
            if target:
                result['entry'] = selected
                signature = inspect.signature(target)
                bound = signature.bind(*args, **kwargs)
                for name, value in bound.arguments.items():
                    bound.arguments[name] = _convert(value, signature.parameters[name])
                actual = target(*bound.args, **bound.kwargs)
                result['result'] = _snapshot(actual)
                returned = True
    except _Limit as error:
        result['limited'] = True
        result['error'] = str(error)
    except BaseException as error:
        result['error'] = type(error).__name__ + ': ' + str(error)[:1000]
    finally:
        sys.settrace(old_trace)
        result['stdout'] = output.getvalue()
    if expected_text.strip():
        if result['error'] or result['limited']:
            result['comparison'] = {'status': 'error', 'message': '执行失败或达到限制，无法比较返回值'}
        elif returned:
            result['comparison'] = _compare_result(actual, expected_text)
        else:
            result['comparison'] = {'status': 'skip', 'message': '未调用入口函数，缺少可比较的返回值'}
    return result
