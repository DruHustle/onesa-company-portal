"""Directional schema compatibility; unknown changes still fail closed."""

def schema_subset(narrow, broad):
    if narrow == broad or broad == {}:
        return True
    if not isinstance(narrow, dict) or not isinstance(broad, dict):
        return False
    if 'anyOf' in narrow:
        return all(schema_subset(branch, broad) for branch in narrow['anyOf'])
    if 'anyOf' in broad:
        return any(schema_subset(narrow, branch) for branch in broad['anyOf'])
    if broad.get('type') and narrow.get('type') != broad['type']:
        return False
    if 'enum' in broad and not set(narrow.get('enum', [])) <= set(broad['enum']):
        return False
    if 'enum' in broad and 'enum' not in narrow:
        return False
    if 'const' in broad and narrow.get('const') != broad['const']:
        return False
    for key in ['minLength', 'minimum', 'minItems', 'minProperties']:
        if key in broad and narrow.get(key, float('-inf')) < broad[key]:
            return False
    for key in ['maxLength', 'maximum', 'maxItems', 'maxProperties']:
        if key in broad and narrow.get(key, float('inf')) > broad[key]:
            return False
    if broad.get('type') == 'object':
        if not set(broad.get('required', [])) <= set(narrow.get('required', [])):
            return False
        old, new = broad.get('properties', {}), narrow.get('properties', {})
        for name, schema in old.items():
            if name in new and not schema_subset(new[name], schema):
                return False
            if name not in new and name in broad.get('required', []):
                return False
            if name not in new and narrow.get('additionalProperties', True) is not False:
                return False
        extra = broad.get('additionalProperties', True)
        if extra is False and (narrow.get('additionalProperties', True) is not False or set(new) - set(old)):
            return False
        if isinstance(extra, dict):
            for name in set(new) - set(old):
                if not schema_subset(new[name], extra):
                    return False
            new_extra = narrow.get('additionalProperties', True)
            if new_extra is not False and (not isinstance(new_extra, dict) or not schema_subset(new_extra, extra)):
                return False
    if broad.get('type') == 'array' and not schema_subset(narrow.get('items', {}), broad.get('items', {})):
        return False
    known = {'type', 'enum', 'const', 'minLength', 'minimum', 'minItems', 'minProperties', 'maxLength', 'maximum', 'maxItems', 'maxProperties', 'required', 'properties', 'additionalProperties', 'items'}
    return all(key in known or narrow.get(key) == value for key, value in broad.items())


def response_compatible(before, after):
    if before == after:
        return True
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    for status, old in before.items():
        current = after.get(status)
        if current is None:
            return False
        for media, entry in old.get('content', {}).items():
            new = current.get('content', {}).get(media)
            if new is None or not schema_subset(new.get('schema', {}), entry.get('schema', {})):
                return False
            if {k:v for k,v in entry.items() if k != 'schema'} != {k:v for k,v in new.items() if k != 'schema'}:
                return False
        if {k:v for k,v in old.items() if k != 'content'} != {k:v for k,v in current.items() if k != 'content'}:
            return False
    # New response status codes still require explicit review.
    return set(before) == set(after)


def request_compatible(before, after):
    if before == after:
        return True
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    if after.get("required", False) and not before.get("required", False):
        return False
    for media, old in before.get("content", {}).items():
        current = after.get("content", {}).get(media)
        if current is None or not schema_subset(old.get("schema", {}), current.get("schema", {})):
            return False
    return {k:v for k,v in before.items() if k not in {"content", "required"}} == {k:v for k,v in after.items() if k not in {"content", "required"}}
