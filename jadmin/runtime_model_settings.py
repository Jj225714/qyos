"""Model settings jobs; keep slow provider calls off the web request thread."""

from contextlib import closing
import json
import math
from pathlib import Path
import secrets
import threading
import time

from runtime_model_client import MODEL, IDENTIFIER, ModelError, active, request, valid

ENABLE_FILE = Path('/etc/qyos/runtime-models-enabled')


def init_db(c):
    c.execute('''create table if not exists pilot_model_transition(
        id integer primary key check(id=1), model_before text not null, model_after text not null,
        operation_id text not null, transition_id text, actor text not null, updated integer not null)''')
    c.commit()


def chat_transition_pending(c):
    return c.execute('select 1 from pilot_model_transition where id=1').fetchone() is not None


def check_chat_write(c, operation_id):
    row = c.execute('select operation_id from pilot_model_transition where id=1').fetchone()
    if row and row[0] != operation_id:
        raise ModelError('config_busy', 409)


class Settings:
    def __init__(self, host):
        self.host = host
        self.guard = threading.Lock()
        self.chat_lock = threading.Lock()
        self.jobs = {}
        self.probe_times = {}

    def summary(self, c):
        result = {}
        for module in ('chat', 'image'):
            try:
                value = active(module)
                editable = ENABLE_FILE.is_file() and value.get('editable', True) is True
                item = {'model': value['model'], 'revision': value['revision'], 'editable': editable}
                if module == 'image' and 'routeVerified' in value:
                    item['routeVerified'] = value['routeVerified'] is True
                if module == 'chat':
                    view = self.host.model_service().pilot_status(c)
                    if chat_transition_pending(c) or value.get('pending'):
                        item.update(editable=False, message='正在核对上次更改，请稍后重新读取。')
                    elif not view.get('editable', True) or view.get('model') != value['model']:
                        item.update(editable=False, message='聊天服务与后台配置尚未一致，请先核对普通聊天配置。')
                result[module] = item
            except (ModelError, self.host.model_config_service.ServiceError):
                result[module] = {'editable': False}
        return result

    def job_status(self, job_id, actor):
        with self.guard:
            job = self.jobs.get(job_id)
            if not job or job['actor'] != actor:
                raise ModelError('job_missing', 404)
            if job['pending']:
                return {'pending': True}
            if isinstance(job['result'], ModelError):
                raise job['result']
            return job['result']

    def start(self, c, module, action, data, actor):
        if not ENABLE_FILE.is_file():
            raise ModelError('runtime_unavailable', 503)
        if module not in ('chat', 'image') or action not in ('probe', 'save') or not isinstance(data, dict):
            raise ModelError('invalid_request')
        expected_keys = {'model', 'revision'}
        if action == 'save':
            expected_keys.add('probeId')
        elif module == 'image':
            expected_keys.add('confirmImageProbe')
            if data.get('confirmImageProbe') is not True:
                raise ModelError('image_cost_confirmation_required')
        if set(data) != expected_keys or not valid(MODEL, data['model']) or not valid(IDENTIFIER, data['revision']):
            raise ModelError('invalid_request')
        front_id = data.get('probeId')
        if action == 'save' and not valid(IDENTIFIER, front_id):
            raise ModelError('test_required')
        revision, model = data['revision'], data['model']
        now = time.monotonic()
        with self.guard:
            self.jobs = {key: job for key, job in self.jobs.items() if job['pending'] or now - job['start'] < 1800}
            if module == 'image' and action == 'probe':
                for existing_id, existing in reversed(self.jobs.items()):
                    if (existing['actor'], existing['module'], existing['action'], existing['model'], existing['revision']) == (actor, module, action, model, revision):
                        if existing['pending'] or existing.get('runtime_probe') and now - existing['start'] < 540:
                            return {'jobId': existing_id}
            if len(self.jobs) >= 200 or any(x['pending'] and x['module'] == module for x in self.jobs.values()):
                raise ModelError('config_busy', 409)
            if action == 'save':
                test = self.jobs.get(front_id)
                if (not test or test['actor'] != actor or test['module'] != module or test['action'] != 'probe'
                        or test['model'] != model or test['revision'] != revision or test['pending']
                        or not test.get('runtime_probe') or now - test['start'] > 600):
                    raise ModelError('test_required', 409)
                runtime_probe = test.pop('runtime_probe')
            else:
                runtime_probe = None
                wait = self.probe_times.get(module, -100) + 10 - now
                if wait > 0:
                    raise ModelError('probe_rate_limited', 429, math.ceil(wait))
                self.probe_times[module] = now
            job_id = secrets.token_hex(16)
            job = {'actor': actor, 'module': module, 'action': action, 'model': model,
                   'revision': revision, 'pending': True, 'start': now}
            self.jobs[job_id] = job
        worker = threading.Thread(target=self._run, args=(job_id, job, runtime_probe), daemon=True)
        try:
            worker.start()
        except RuntimeError:
            with self.guard:
                self.jobs.pop(job_id, None)
            raise ModelError('runtime_unavailable', 503) from None
        return {'jobId': job_id}

    def _run(self, job_id, job, runtime_probe):
        module, model, revision, actor = (job[k] for k in ('module', 'model', 'revision', 'actor'))
        try:
            with closing(self.host.connect()) as c:
                if not self.host.is_admin_actor(c, actor):
                    raise ModelError('administrator_required', 403)
                state = self.summary(c).get(module, {})
                if not state.get('editable'):
                    raise ModelError('runtime_unavailable', 503)
                if revision != state['revision']:
                    raise ModelError('revision_conflict', 409)
                payload = {'model': model, 'revision': revision}
                if job['action'] == 'probe':
                    probe = request(module, 'probe', payload).get('probeId')
                    if not valid(IDENTIFIER, probe):
                        raise ModelError('probe_failed', 502)
                    job['runtime_probe'] = probe
                    result = {'probeId': job_id}
                elif state['model'] == model and not (module == 'image' and state.get('routeVerified') is False):
                    result = {'model': model, 'applied': True}
                elif module == 'image':
                    if not self.host.is_admin_actor(c, actor):
                        raise ModelError('administrator_required', 403)
                    try:
                        request(module, 'commit', {**payload, 'probeId': runtime_probe})
                    except ModelError as error:
                        # A response can be lost after an atomic state change.
                        if error.status < 500 or active(module)['model'] != model:
                            raise
                    applied = active(module)
                    if applied['model'] != model or applied.get('routeVerified') is False:
                        raise ModelError('runtime_unavailable', 503)
                    result = {'model': model, 'applied': True}
                else:
                    self._change_chat(c, state['model'], payload, actor, runtime_probe)
                    result = {'model': model, 'applied': True}
                self._audit(c, job, 'ok')
        except ModelError as error:
            result = error
        except Exception:
            result = ModelError('runtime_unavailable', 503)
        if isinstance(result, ModelError):
            try:
                with closing(self.host.connect()) as c:
                    self._audit(c, job, result.code)
            except Exception:
                pass
        with self.guard:
            job['pending'] = False
            job['result'] = result

    def _audit(self, c, job, outcome):
        try:
            detail = {key: job[key] for key in ('actor', 'module', 'action', 'model')}
            self.host.audit(c, 'corporate_model_setting', json.dumps({**detail, 'outcome': outcome}))
        except Exception:
            pass

    def _change_chat(self, c, current, payload, actor, probe):
        with self.chat_lock:
            self._change_chat_locked(c, current, payload, actor, probe)

    def _change_chat_locked(self, c, current, payload, actor, probe):
        service = self.host.model_service()
        next_model = payload['model']
        operation = secrets.token_hex(16)
        with self.host._LC_FILES_LOCK:
            state = service.pilot_status(c)
            if chat_transition_pending(c) or not state.get('editable', True) or state['model'] != current:
                raise ModelError('revision_conflict', 409)
            service.ensure_apply_idle(c)
            if not self.host.is_admin_actor(c, actor):
                raise ModelError('administrator_required', 403)
            c.execute('insert into pilot_model_transition values(1,?,?,?,null,?,?)',
                      (current, next_model, operation, actor, int(time.time())))
            c.commit()
        try:
            allowed = request('chat', 'allow', {**payload, 'probeId': probe})
        except ModelError as error:
            if error.status < 500 and not active('chat').get('pending'):
                self._clear(c)
            raise
        transition = allowed.get('transitionId')
        if not valid(IDENTIFIER, transition):
            raise ModelError('runtime_unavailable', 503)
        c.execute('update pilot_model_transition set transition_id=? where id=1', (transition,))
        c.commit()
        try:
            if not self.host.is_admin_actor(c, actor):
                raise ModelError('administrator_required', 403)
            revision = service.save_pilot(c, {'model': next_model, 'expectedModel': current,
                                              'expectedRevision': state['revision']},
                                          actor, operation_id=operation)['revision']
            self._apply(c, service, actor, revision, operation)
        except (ModelError, self.host.model_config_service.ServiceError):
            pass  # Recover from a verified result or restore the previous model.
        if self._recover_locked(c) != next_model:
            raise ModelError('apply_failed', 502)

    @staticmethod
    def _apply(c, service, actor, revision, operation):
        expected = service.apply(c, {'expectedRevision': revision}, actor, operation_id=operation)['requestId']
        # The helper owns the runtime restart and adoption checks.
        until = time.monotonic() + 425
        while time.monotonic() < until:
            with service.host._LC_FILES_LOCK:
                state = service._state(c)
                if state['apply_request_id'] != expected:
                    return False
                if state['apply_state'] not in ('queued', 'applying'):
                    return state['apply_state'] == 'applied_healthy' and state['applied_revision'] == revision
            time.sleep(0.75)
        return False

    def _recover_locked(self, c):
        row = c.execute('select * from pilot_model_transition where id=1').fetchone()
        if row is None:
            return None
        service = self.host.model_service()
        before, after, op, actor = (row[k] for k in ('model_before', 'model_after', 'operation_id', 'actor'))
        with self.host._LC_FILES_LOCK:
            service.ensure_apply_idle(c)
            view, state = service.pilot_status(c), service._state(c)
        configured, revision = view['model'], view['revision']
        runtime = active('chat')
        pending = runtime.get('pending')
        transition = None
        if pending is not None:
            if (not isinstance(pending, dict) or runtime['model'] != before or pending.get('model') != after
                    or not valid(IDENTIFIER, pending.get('transitionId'))
                    or (row['transition_id'] and row['transition_id'] != pending['transitionId'])):
                raise ModelError('runtime_unavailable', 503)
            transition = pending['transitionId']
        if configured == after and state['apply_state'] == 'applied_healthy' and state['applied_revision'] == revision:
            if transition:
                request('chat', 'commit', {'transitionId': transition})
            if active('chat')['model'] != after:
                raise ModelError('runtime_unavailable', 503)
            self._clear(c)
            return after
        if runtime['model'] != before or configured not in (before, after):
            raise ModelError('runtime_unavailable', 503)
        if configured == after:
            revision = service.save_pilot(c, {'model': before, 'expectedModel': after, 'expectedRevision': revision},
                                          actor, operation_id=op)['revision']
        if configured == after or row['transition_id']:
            if not (state['apply_state'] == 'applied_healthy' and state['applied_revision'] == revision):
                if not self._apply(c, service, actor, revision, op):
                    raise ModelError('runtime_unavailable', 503)
        if transition:
            request('chat', 'revert', {'transitionId': transition})
        live = active('chat')
        if live['model'] != before or live.get('pending'):
            raise ModelError('runtime_unavailable', 503)
        self._clear(c)
        return before

    def recover(self):
        """Finish or restore interrupted chat transitions after a process restart."""
        while True:
            time.sleep(20)
            with self.chat_lock:
                try:
                    with closing(self.host.connect()) as c:
                        self._recover_locked(c)
                except Exception:
                    # Pending stays durable; never retire the old route blindly.
                    time.sleep(20)

    @staticmethod
    def _clear(c):
        c.execute('delete from pilot_model_transition where id=1')
        c.commit()
