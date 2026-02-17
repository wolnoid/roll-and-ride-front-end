import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router';
import { signUp } from '../../services/authService';
import { UserContext } from '../../contexts/UserContext';
import styles from './SignUpForm.module.css';

const SignUpForm = ({ embedded = false, onCancel, onSwitchToSignIn, onSuccess }) => {
  const navigate = useNavigate();
  const { setUser } = useContext(UserContext);
  const [message, setMessage] = useState('');
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    passwordConf: '',
  });

  const { username, password, passwordConf } = formData;

  const handleChange = (evt) => {
    setMessage('');
    setFormData({ ...formData, [evt.target.name]: evt.target.value });
  };

  const handleSubmit = async (evt) => {
    evt.preventDefault();
    try {
      const newUser = await signUp(formData);
      setUser(newUser);
      onSuccess?.(newUser);
      navigate('/');
    } catch (err) {
      setMessage(err.message);
    }
  };

  const isFormInvalid = () => {
    return !(username && password && password === passwordConf);
  };

  const handleCancel = () => {
    if (embedded) {
      onCancel?.();
      return;
    }
    navigate('/');
  };

  return (
    <main className={`${styles.page} ${embedded ? styles.embeddedPage : ''}`}>
      <section className={styles.formPane}>
        <form
          className={`${styles.form} ${embedded ? styles.embeddedForm : ''}`}
          autoComplete='off'
          onSubmit={handleSubmit}
        >
          <h1>Sign Up</h1>
          <p className={styles.message}>
            {message || 'Create an account to save directions for future reference'}
          </p>
          <div className={styles.field}>
            <label htmlFor='username'>Username</label>
            <input
              className={styles.input}
              type='text'
              id='username'
              value={username}
              name='username'
              onChange={handleChange}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor='password'>Password</label>
            <input
              className={styles.input}
              type='password'
              id='password'
              value={password}
              name='password'
              onChange={handleChange}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor='confirm'>Confirm Password</label>
            <input
              className={styles.input}
              type='password'
              id='confirm'
              value={passwordConf}
              name='passwordConf'
              onChange={handleChange}
              required
            />
          </div>
          <div className={styles.actions}>
            <button className={styles.primaryButton} type='submit' disabled={isFormInvalid()}>
              Sign Up
            </button>
            <button
              className={styles.secondaryButton}
              type='button'
              onClick={handleCancel}
            >
              Cancel
            </button>
          </div>
          {embedded ? (
            <p className={styles.authSwitch}>
              Already a user?{' '}
              <button type='button' className={styles.inlineLink} onClick={onSwitchToSignIn}>
                Sign in
              </button>
            </p>
          ) : (
            <p className={styles.authSwitch}>
              <Link to='/sign-in'>Already a user? Sign in</Link>
            </p>
          )}
        </form>
      </section>
    </main>
  );
};

export default SignUpForm;
